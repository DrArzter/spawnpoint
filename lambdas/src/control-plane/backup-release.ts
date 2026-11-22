// The release a backup is restored onto (ADR-0052). A backup is world data
// plus the release that ran it, and after a promotion that is not the release
// its wipe started with.

import { releaseRunAt, type ReleaseState, type WorldRef } from "./release-state.ts";
import type { WorldGeneration, WorldRecord } from "./world-registry.ts";

/** recorded: the host wrote the active release on the archive. ran: the wipe's own record of what it ran. origin: what the wipe started with. */
export type BackupReleaseSource = "recorded" | "ran" | "origin";
export type BackupRelease = Readonly<{ release: string; source: BackupReleaseSource }>;

/** The metadata the host wrote on an archive (upload-world-backup.sh). */
export type ArchiveMetadata = Readonly<{ release: string | null; releaseSource: string | null; storedAt: string }>;

export type BackupReleaseSources = Readonly<{
  /** Null when the archive does not exist. */
  readArchiveMetadata(key: string): Promise<ArchiveMetadata | null>;
  readReleaseState(ref: WorldRef): Promise<ReleaseState | null>;
}>;

const RELEASE = /^\d+\.\d+$/;

export function backupGenerationId(key: string): string | null {
  return /-(gen-[0-9a-f]{32})-/.exec(key)?.[1] ?? null;
}

export function backupRelease(
  generation: WorldGeneration,
  archive: ArchiveMetadata,
  state: ReleaseState | null,
): BackupRelease {
  // Only a release the host read from the active pointer is trusted. An older
  // archive carries the wipe's origin release under the same key.
  if (archive.releaseSource === "active" && archive.release !== null && RELEASE.test(archive.release)) {
    return { release: archive.release, source: "recorded" };
  }
  const runs = state?.releasesRun ?? [];
  const ran = runs.length > 0 ? releaseRunAt(runs, archive.storedAt) : state?.activeRelease ?? null;
  if (ran !== null) return { release: ran, source: "ran" };
  return { release: generation.release, source: "origin" };
}

export async function resolveBackupRelease(
  record: WorldRecord,
  key: string,
  sources: BackupReleaseSources,
): Promise<BackupRelease | "unknown_generation" | "unknown_backup"> {
  const generationId = backupGenerationId(key);
  const generation = [record.currentGeneration, ...record.previousGenerations].find((candidate) => candidate.id === generationId);
  if (generation === undefined) return "unknown_generation";
  const [archive, state] = await Promise.all([
    sources.readArchiveMetadata(key),
    sources.readReleaseState({ worldId: record.worldId, generationId: generation.id }),
  ]);
  if (archive === null) return "unknown_backup";
  return backupRelease(generation, archive, state);
}

export type BackupWithRelease<T> = T & Readonly<{ release: string | null; releaseSource: BackupReleaseSource | null }>;

/** Each listed backup with the release a restore would use; null where it cannot be read now. */
export async function withBackupReleases<T extends Readonly<{ key: string }>>(
  record: WorldRecord | null,
  entries: readonly T[],
  sources: BackupReleaseSources,
): Promise<BackupWithRelease<T>[]> {
  const states = new Map<string, Promise<ReleaseState | null>>();
  const cached: BackupReleaseSources = {
    readArchiveMetadata: (key) => sources.readArchiveMetadata(key),
    readReleaseState(ref) {
      const known = states.get(ref.generationId) ?? sources.readReleaseState(ref);
      states.set(ref.generationId, known);
      return known;
    },
  };
  return Promise.all(entries.map(async (entry) => {
    if (record === null) return { ...entry, release: null, releaseSource: null };
    try {
      const ran = await resolveBackupRelease(record, entry.key, cached);
      return typeof ran === "string" ? { ...entry, release: null, releaseSource: null } : { ...entry, release: ran.release, releaseSource: ran.source };
    } catch (error) {
      console.error("backup_release_unreadable", { worldId: record.worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
      return { ...entry, release: null, releaseSource: null };
    }
  }));
}
