import { noReleaseState, requireReleaseUsable, type ReleaseStateReader } from "./release-usable.ts";
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
  readState: ReleaseStateReader = noReleaseState,
): Promise<WorldRecord> {
  const next = restoreWorldRecord(record, backup, generationUuid, createdAt);
  if (!await releaseExists(record.gameId, record.preset.id, next.currentGeneration.release)) {
    throw new Error("release_missing");
  }
  // A release being retired is still in the store, and still must not be restored onto (ADR-0080).
  await requireReleaseUsable(readState, record.gameId, record.preset.id, next.currentGeneration.release);
  return next;
}
