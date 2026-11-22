import { restoreWorldRecord, type WorldRecord } from "./world-registry.ts";

/**
 * Keep the existence check adjacent to the registry mutation, not only at the
 * HTTP entry point. `backup.release` is the release the backup ran.
 */
export async function restoreWithPublishedRelease(
  record: WorldRecord,
  backup: Readonly<{ key: string; checksum: string; generationId: string; release?: string }>,
  generationUuid: string,
  createdAt: string,
  releaseExists: (gameId: string, presetId: string, release: string) => Promise<boolean>,
): Promise<WorldRecord> {
  const next = restoreWorldRecord(record, backup, generationUuid, createdAt);
  if (!await releaseExists(record.gameId, record.preset.id, next.currentGeneration.release)) {
    throw new Error("release_missing");
  }
  return next;
}
