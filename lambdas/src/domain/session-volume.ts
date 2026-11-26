/*
 * The session volume (ADR-0102): one EBS volume per session on a launched
 * host, tagged as Spawnpoint's and with the session it belongs to. These are
 * the tag values Terraform renders into the workflows and IAM
 * (infra/terraform-operations/session-volume.tf); a test keeps them equal.
 */

export const SESSION_VOLUME_MANAGED_BY = "spawnpoint-session-volume";
export const SESSION_VOLUME_SESSION_TAG = "SessionId";
export const SESSION_VOLUME_WORLD_TAG = "WorldId";

/** A volume younger than this is never deleted: its start may still be writing its session. */
export const SESSION_VOLUME_GRACE_SECONDS = 3600;
/** An orphan still attached after this long is reported: a host should have let it go by now. */
export const SESSION_VOLUME_ATTACHED_ORPHAN_SECONDS = 4 * 3600;

export type SessionVolume = Readonly<{
  volumeId: string;
  state: string;
  createdAtEpochSeconds: number;
  sessionId: string | null;
  worldId: string | null;
}>;

/** What the lifecycle says about the volume's world now. */
export type WorldLiveness = Readonly<{ activeSessionId: string | null }>;

export type SessionVolumeSweepAction = "keep" | "delete" | "report";

/** Decide without side effects. The caller has already restricted EC2 to tagged volumes. */
export function sessionVolumeSweepAction(volume: SessionVolume, world: WorldLiveness | null, nowEpochSeconds: number): SessionVolumeSweepAction {
  const age = nowEpochSeconds - volume.createdAtEpochSeconds;
  if (age < SESSION_VOLUME_GRACE_SECONDS) return "keep";
  // A volume that names no session cannot be matched to one; a person decides.
  if (volume.sessionId === null || volume.worldId === null) return "report";
  if (world !== null && world.activeSessionId === volume.sessionId) return "keep";
  if (volume.state === "available") return "delete";
  return age >= SESSION_VOLUME_ATTACHED_ORPHAN_SECONDS ? "report" : "keep";
}
