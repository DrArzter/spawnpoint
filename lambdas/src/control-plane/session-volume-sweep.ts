import { sessionVolumeSweepAction, type SessionVolume } from "../domain/session-volume.ts";
import type { LifecycleStore } from "../lifecycle/coordinator.ts";
import { sessionLifecycleKey } from "./world-session.ts";

/** The session volume port: Spawnpoint's tagged volumes, and deleting one. */
export type SessionVolumes = Readonly<{
  list(): Promise<SessionVolume[]>;
  delete(volumeId: string): Promise<void>;
}>;

export type SessionVolumeSweepResult = Readonly<{ deleted: string[]; survivors: string[] }>;

type Log = Pick<Console, "info">;

/**
 * ADR-0102: delete each available session volume whose session is not live.
 * Only fleet sessions get a volume, so the world's own record is the one to
 * read. A volume that cannot be deleted, or that stays attached with no live
 * session, survives the sweep and is reported.
 */
export async function sweepSessionVolumes(
  volumes: SessionVolumes,
  lifecycle: Pick<LifecycleStore, "read">,
  nowEpochSeconds: number,
  log: Log,
): Promise<SessionVolumeSweepResult> {
  const deleted: string[] = [];
  const survivors: string[] = [];
  const inspect = async (volume: SessionVolume) => {
    const world = volume.worldId === null ? null : await lifecycle.read(sessionLifecycleKey(volume.worldId, volume.worldId, "fleet"));
    const action = sessionVolumeSweepAction(volume, world?.record ?? null, nowEpochSeconds);
    if (action === "keep") return;
    if (action === "report") {
      survivors.push(`${volume.volumeId}: ${volume.state}, session ${volume.sessionId ?? "untagged"} not live`);
      return;
    }
    try {
      await volumes.delete(volume.volumeId);
      deleted.push(volume.volumeId);
      log.info("deleted orphaned session volume", volume.volumeId, volume.sessionId);
    } catch (error) {
      survivors.push(`${volume.volumeId}: delete failed, ${error instanceof Error ? error.name : "unknown error"}`);
    }
  };
  await Promise.all((await volumes.list()).map(inspect));
  return { deleted, survivors };
}
