import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { backupInventory, byCodeUnit, resumeArchiveKey, type BackupEntry } from "../control-plane/backups.ts";
import { S3ReleaseStateReader } from "../control-plane/s3-release-state-store.ts";
import { S3WorldReader } from "../control-plane/s3-world-repository.ts";
import type { WorldRecord } from "../control-plane/world-registry.ts";
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

type S3Send = Pick<S3Client, "send">;

const WORLD_PREFIX = /^worlds\/([a-z0-9][a-z0-9-]{0,31})\/$/;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

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
  entries: readonly BackupEntry[],
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
  const byGeneration = new Map<string, BackupEntry[]>();
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

export function s3RetentionStore(
  s3: S3Send, backupBucket: string, worlds: Pick<S3WorldReader, "read">, releaseBucket?: string,
): RetentionStore {
  const states = releaseBucket === undefined ? null : new S3ReleaseStateReader(s3 as S3Client, releaseBucket);
  return {
    async listWorldIds() {
      const ids: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
          Bucket: backupBucket, Prefix: "worlds/", Delimiter: "/", ...(token ? { ContinuationToken: token } : {}),
        }));
        for (const prefix of page.CommonPrefixes ?? []) {
          const id = prefix.Prefix?.match(WORLD_PREFIX)?.[1];
          if (id !== undefined) ids.push(id);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return ids;
    },
    async listArchives(worldId) {
      const objects: ArchiveObject[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
          Bucket: backupBucket, Prefix: `worlds/${worldId}/archives/`, ...(token ? { ContinuationToken: token } : {}),
        }));
        for (const object of page.Contents ?? []) {
          if (!object.Key || !object.LastModified) continue;
          objects.push({
            key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(),
            checksumAlgorithms: object.ChecksumAlgorithm ?? [],
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async readWorld(worldId) {
      return (await worlds.read(worldId))?.record ?? null;
    },
    async readPrePromotionBackups(record) {
      if (states === null) return [];
      const keys: string[] = [];
      // A pointer that cannot be read fails this world's run, so nothing of it is removed.
      for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
        const stored = await states.read({ worldId: record.worldId, generationId: generation.id }); // NOSONAR few wipes per world
        if (stored?.state.prePromotionBackup) keys.push(stored.state.prePromotionBackup.key);
      }
      return keys;
    },
    async deleteArchive(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: backupBucket, Key: key }));
    },
  };
}

export async function handler(): Promise<Readonly<{ worlds: number; removed: number }>> {
  const s3 = new S3Client({});
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  const store = s3RetentionStore(s3, requiredEnv("BACKUP_BUCKET"), new S3WorldReader(s3, releaseBucket), releaseBucket);
  const results = await applyBackupRetention(store);
  for (const result of results) {
    if (result.removed.length > 0) console.info("backup_retention_removed", { worldId: result.worldId, keys: result.removed });
  }
  const failed = results.filter((result) => result.result === "failed").map((result) => result.worldId);
  // Throwing after every world was tried counts as a Lambda error, which the alarm reports.
  if (failed.length > 0) throw new Error(`backup retention failed for ${failed.join(", ")}`);
  return { worlds: results.length, removed: results.reduce((sum, result) => sum + result.removed.length, 0) };
}
