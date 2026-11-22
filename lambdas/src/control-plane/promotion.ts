// Promote a fleet world's open wipe to another release of its preset
// (ADR-0078). The workflow does the work; this decides whether to ask for it.

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { usableByExistingWorld, type PresetObservation } from "./preset-catalog.ts";
import type { ReleasePointerObservation } from "./read-model.ts";
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
  | "release_state_unavailable"
  | "no_active_release"
  | "release_already_active"
  | "release_older_than_active"
  | "players_online"
  | "operation_in_progress"
  | "configured_host_unavailable";

export type PromotionPlan =
  | Readonly<{ kind: "reject"; status: 400 | 404 | 409; error: PromotionRefusal }>
  | Readonly<{ kind: "execute"; record: WorldRecord; release: string; previous: string; instanceId: string }>;

export type PromotionFacts = Readonly<{
  gameId: string;
  release: unknown;
  record: WorldRecord | undefined;
  preset: PresetObservation | undefined;
  pointer: ReleasePointerObservation;
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

export function planPromotion(facts: PromotionFacts): PromotionPlan {
  const { record, preset, pointer, release } = facts;
  if (typeof release !== "string" || !RELEASE.test(release)) return reject(400, "invalid_release");
  if (record === undefined || record.gameId !== facts.gameId) return reject(404, "unknown_world");
  if (record.status !== "active") return reject(409, "world_archived");
  // A configured world is promoted with scripts/promote-release.sh.
  if (record.placement !== "fleet") return reject(409, "promotion_needs_fleet_world");
  if (!facts.launchEnabled) return reject(409, "fleet_unavailable");
  // Only a release of the world's own preset: a world never changes preset.
  if (preset === undefined || preset.gameId !== record.gameId || preset.id !== record.preset.id) return reject(409, "preset_removed");
  if (!usableByExistingWorld(preset, release)) return reject(409, "release_not_available");
  if (pointer.state !== "available" || pointer.generationId !== record.currentGeneration.id) return reject(409, "release_state_unavailable");
  // A wipe that never passed a start has nothing to roll back to; a new wipe gives it a release.
  if (pointer.activeRelease === null) return reject(409, "no_active_release");
  if (pointer.activeRelease === release) return reject(409, "release_already_active");
  // Rollback is by restore (ADR-0052): a promotion only moves forward along the
  // preset's ordered releases (ADR-0042). An active release the catalog no
  // longer lists cannot be ordered, so it does not refuse.
  const at = preset.releases.indexOf(pointer.activeRelease);
  if (at !== -1 && preset.releases.indexOf(release) < at) return reject(409, "release_older_than_active");
  // The workflow's stop refuses with players online too; this answers before it is asked.
  if ((facts.session?.idle?.playersOnline ?? 0) > 0) return reject(409, "players_online");
  if (facts.blockingOperations > 0) return reject(409, "operation_in_progress");
  if (facts.configuredHostId === undefined) return reject(409, "configured_host_unavailable");
  return { kind: "execute", record, release, previous: pointer.activeRelease, instanceId: facts.configuredHostId };
}
