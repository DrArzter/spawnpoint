import { backupInventory, byCodeUnit, resumeArchiveKey, type ListedBackup } from "./backups.ts";
import type { WorldRecord } from "./world-registry.ts";
import { planBackupRetention } from "../domain/backup-retention.ts";

// Applies ADR-0010's 5/2/2 to each world, once per generation. A delete on the
// versioned bucket leaves a noncurrent version for 30 days, so a wrong delete
// can still be recovered. Unverified objects are never planned, so never deleted.

export type ArchiveObject = Readonly<{
  key: string;
  sizeBytes: number;
  storedAt: string;
  checksumAlgorithms: readonly string[];
}>;

export type RetentionStore = Readonly<{
  listWorldIds(): Promise<readonly string[]>;
  listArchives(worldId: string): Promise<readonly ArchiveObject[]>;
  readWorld(worldId: string): Promise<WorldRecord | null>;
  /** The pre-promotion backup each wipe of the world names on its release pointer. */
  readPrePromotionBackups(record: WorldRecord): Promise<readonly string[]>;
  deleteArchive(key: string): Promise<void>;
}>;

export type WorldRetention = Readonly<{
  worldId: string;
  result: "applied" | "no_world_record" | "failed";
  removed: readonly string[];
}>;

/** The archive the next start resumes from: the greatest key of the open generation, as server/scripts/prepare-world.sh picks it. */
export function resumeKey(record: WorldRecord, keys: readonly string[]): string | undefined {
  return resumeArchiveKey(record.worldId, record.currentGeneration.id, keys);
}

/**
 * Keys no plan may remove: the newest verified archive of the open generation by
 * upload time and the one the next start resumes from by name (a retried upload
 * can make the two differ), every archive a generation was restored from, and
 * each wipe's pre-promotion backup until its next promotion names another (ADR-0030).
 */
export function protectedKeys(
  record: WorldRecord,
  entries: readonly ListedBackup[],
  keys: readonly string[] = entries.map((entry) => entry.key),
  prePromotion: readonly string[] = [],
): ReadonlySet<string> {
  const protect = new Set<string>(prePromotion);
  const open = entries
    .filter((entry) => entry.generationId === record.currentGeneration.id)
    .sort((left, right) => right.storedAt.localeCompare(left.storedAt))[0];
  if (open !== undefined) protect.add(open.key);
  const resume = resumeKey(record, keys);
  if (resume !== undefined) protect.add(resume);
  for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
    if (generation.source.kind === "backup") protect.add(generation.source.key);
  }
  return protect;
}

export function archivesToRemove(record: WorldRecord, objects: readonly ArchiveObject[], prePromotion: readonly string[] = []): readonly string[] {
  const entries = backupInventory(objects, Number.POSITIVE_INFINITY).entries;
  const keep = protectedKeys(record, entries, objects.map((object) => object.key), prePromotion);
  const byGeneration = new Map<string, ListedBackup[]>();
  for (const entry of entries) {
    const generation = entry.generationId ?? "none";
    byGeneration.set(generation, [...(byGeneration.get(generation) ?? []), entry]);
  }
  const remove: string[] = [];
  for (const generation of byGeneration.values()) {
    const plan = planBackupRetention(generation.map((entry) => ({ key: entry.key, lastModified: entry.storedAt })));
    remove.push(...plan.remove.map((backup) => backup.key).filter((key) => !keep.has(key)));
  }
  return remove.sort(byCodeUnit);
}

export async function applyBackupRetention(store: RetentionStore): Promise<readonly WorldRetention[]> {
  const results: WorldRetention[] = [];
  for (const worldId of await store.listWorldIds()) {
    try {
      // A world with no record has nothing to say which generation is open,
      // so nothing of it is touched.
      const record = await store.readWorld(worldId); // NOSONAR one world at a time: a failure is recorded per world
      if (record === null) {
        results.push({ worldId, result: "no_world_record", removed: [] });
        continue;
      }
      const prePromotion = await store.readPrePromotionBackups(record); // NOSONAR one world at a time: a failure is recorded per world
      const removed = archivesToRemove(record, await store.listArchives(worldId), prePromotion); // NOSONAR one world at a time: a failure is recorded per world
      for (const key of removed) await store.deleteArchive(key); // NOSONAR ordered, fail-fast deletes
      results.push({ worldId, result: "applied", removed });
    } catch (error) {
      console.error("backup_retention_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
      results.push({ worldId, result: "failed", removed: [] });
    }
  }
  return results;
}

