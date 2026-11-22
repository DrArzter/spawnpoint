// Promote a fleet world's open wipe to another release of its preset
// (ADR-0078). The workflow does the work; this decides whether to ask for it.
// A wipe that never started is not promoted: it is switched, with no workflow.

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { isOlderRevision, usableByExistingWorld, type PresetObservation } from "./preset-catalog.ts";
import type { ReleasePointerObservation } from "./read-model.ts";
import type { ReleaseUsability } from "./release-usable.ts";
import type { WorldRecord } from "./world-registry.ts";

const RELEASE = /^\d+\.\d+$/;

export type PromotionRefusal =
  | "invalid_release"
  | "unknown_world"
  | "world_archived"
  | "promotion_needs_fleet_world"
  | "fleet_unavailable"
  | "preset_removed"
  | "release_not_available"
  | "release_retired"
  | "release_not_ready"
  | "release_state_unavailable"
  | "release_outdated"
  | "world_already_started"
  | "session_active"
  | "release_already_selected"
  | "release_already_active"
  | "release_older_than_active"
  | "players_online"
  | "operation_in_progress"
  | "configured_host_unavailable";

export type PromotionPlan =
  | Readonly<{ kind: "reject"; status: 400 | 404 | 409; error: PromotionRefusal }>
  | Readonly<{ kind: "execute"; record: WorldRecord; release: string; previous: string; instanceId: string }>
  /** A wipe that never started takes the release at once (ADR-0078). */
  | Readonly<{ kind: "switch"; record: WorldRecord; release: string; previous: string }>;

export type PromotionFacts = Readonly<{
  gameId: string;
  release: unknown;
  record: WorldRecord | undefined;
  preset: PresetObservation | undefined;
  pointer: ReleasePointerObservation;
  /** Whether any archive of the current wipe exists. Read only for a wipe with no active release. */
  hasBackup: boolean;
  /** What the reference table says of the target release (ADR-0080); "usable" for a release it does not know. */
  releaseUsability: ReleaseUsability;
  /** The world's own lifecycle record (ADR-0062). */
  session: LifecycleRecord | null;
  blockingOperations: number;
  launchEnabled: boolean;
  /** The fallback host a V2 machine needs in its input; placement chooses the real one. */
  configuredHostId: string | undefined;
}>;

function reject(status: 400 | 404 | 409, error: PromotionRefusal): PromotionPlan {
  return { kind: "reject", status, error };
}

function isWorldsPreset(preset: PresetObservation | undefined, record: WorldRecord): preset is PresetObservation {
  return preset?.gameId === record.gameId && preset.id === record.preset.id;
}

// An active release the catalog no longer lists cannot be ordered, so it is not older.
function olderThanActive(preset: PresetObservation, active: string, release: string): boolean {
  const at = preset.releases.indexOf(active);
  return at !== -1 && preset.releases.indexOf(release) < at;
}

// A wipe is not started when nothing ran, nothing was saved, and no session holds it.
// The release is any one a new world may use; the wipe has no save to protect.
function planSwitch(facts: PromotionFacts, record: WorldRecord, preset: PresetObservation, release: string, desired: string): PromotionPlan {
  if (!preset.releases.includes(release)) return reject(409, "release_not_available");
  if (isOlderRevision(preset, release)) return reject(409, "release_outdated");
  if (facts.releaseUsability !== "usable") return reject(409, facts.releaseUsability);
  // A wipe restored from a backup holds that save.
  if (record.currentGeneration.source.kind !== "preset" || (facts.pointer.runCount ?? 0) > 0 || facts.hasBackup) return reject(409, "world_already_started");
  // The record may lag the pointer after a crash; repeating the request finishes it.
  if (desired === release && record.currentGeneration.release === release) return reject(409, "release_already_selected");
  if (sessionActive(facts.session)) return reject(409, "session_active");
  if (facts.blockingOperations > 0) return reject(409, "operation_in_progress");
  return { kind: "switch", record, release, previous: desired };
}

function sessionActive(session: LifecycleRecord | null): boolean {
  return session !== null && (session.desiredState === "running" || session.observedState !== "stopped" || session.activeSessionId !== null);
}

// The checks every promotion and switch share: who may ask, and for which world and preset.
type Checked = Readonly<{ kind: "ok"; record: WorldRecord; preset: PresetObservation; release: string }>;

function checkWorld(facts: PromotionFacts): PromotionPlan | Checked {
  const { record, preset, release } = facts;
  if (typeof release !== "string" || !RELEASE.test(release)) return reject(400, "invalid_release");
  if (record === undefined || record.gameId !== facts.gameId) return reject(404, "unknown_world");
  if (record.status !== "active") return reject(409, "world_archived");
  // A configured world is promoted with scripts/promote-release.sh.
  if (record.placement !== "fleet") return reject(409, "promotion_needs_fleet_world");
  if (!facts.launchEnabled) return reject(409, "fleet_unavailable");
  // Only a release of the world's own preset: a world never changes preset.
  return isWorldsPreset(preset, record) ? { kind: "ok", record, preset, release } : reject(409, "preset_removed");
}

function planStarted(facts: PromotionFacts, record: WorldRecord, preset: PresetObservation, release: string): PromotionPlan {
  const { pointer } = facts;
  if (!usableByExistingWorld(preset, release)) return reject(409, "release_not_available");
  if (facts.releaseUsability !== "usable") return reject(409, facts.releaseUsability);
  if (pointer.state !== "available" || pointer.generationId !== record.currentGeneration.id || pointer.activeRelease === null) return reject(409, "release_state_unavailable");
  if (pointer.activeRelease === release) return reject(409, "release_already_active");
  // Rollback is by restore (ADR-0052): a promotion only moves forward along the
  // preset's ordered releases (ADR-0042). An active release the catalog no
  // longer lists cannot be ordered, so it does not refuse.
  if (olderThanActive(preset, pointer.activeRelease, release)) return reject(409, "release_older_than_active");
  // The workflow's stop refuses with players online too; this answers before it is asked.
  if ((facts.session?.idle?.playersOnline ?? 0) > 0) return reject(409, "players_online");
  if (facts.blockingOperations > 0) return reject(409, "operation_in_progress");
  if (facts.configuredHostId === undefined) return reject(409, "configured_host_unavailable");
  return { kind: "execute", record, release, previous: pointer.activeRelease, instanceId: facts.configuredHostId };
}

export function planPromotion(facts: PromotionFacts): PromotionPlan {
  const checked = checkWorld(facts);
  if (checked.kind !== "ok") return checked;
  const { record, preset, release } = checked;
  const { pointer } = facts;
  const unstarted = pointer.state === "available" && pointer.generationId === record.currentGeneration.id && pointer.activeRelease === null;
  if (unstarted) return planSwitch(facts, record, preset, release, pointer.desiredRelease ?? record.currentGeneration.release);
  return planStarted(facts, record, preset, release);
}
