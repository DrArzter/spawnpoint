import { releaseStateDocument, type ReleaseRun, type ReleaseState } from "./release-state.ts";

function validateRelease(release: string): void {
  if (!/^\d+\.\d+$/.test(release)) throw new Error("invalid_release");
}

function changed(
  state: ReleaseState,
  values: Pick<ReleaseState, "desiredRelease" | "activeRelease" | "source">,
  updatedAt: string,
  updatedBy: string,
): ReleaseState {
  const next = { ...state, ...values, updatedAt, updatedBy };
  releaseStateDocument(next);
  return next;
}

export function preparePromotion(state: ReleaseState, release: string, updatedAt: string, updatedBy: string): ReleaseState {
  validateRelease(release);
  return changed(state, {
    desiredRelease: release,
    activeRelease: state.activeRelease,
    source: "promote-prepare",
  }, updatedAt, updatedBy);
}

// Every commit is a start that passed its health check, so the wipe ran this release from now on.
function withRun(runs: readonly ReleaseRun[] | undefined, release: string, since: string): readonly ReleaseRun[] {
  const recorded = runs ?? [];
  return recorded.at(-1)?.release === release ? recorded : [...recorded, { release, since }];
}

export function commitPromotion(state: ReleaseState, release: string, updatedAt: string, updatedBy: string): ReleaseState {
  validateRelease(release);
  if (state.desiredRelease !== release) throw new Error("promotion_target_changed");
  return {
    ...changed(state, {
      desiredRelease: release,
      activeRelease: release,
      source: "promote-commit",
    }, updatedAt, updatedBy),
    releasesRun: withRun(state.releasesRun, release, updatedAt),
  };
}

/**
 * Names the archive a promotion keeps before it changes the release. Only the
 * promotion that prepared the pointer may write it, and it leaves the pointer
 * owned by that promotion so a refusal or rollback can still restore it.
 */
export function recordPrePromotionBackup(state: ReleaseState, key: string, updatedAt: string, updatedBy: string): ReleaseState {
  if (state.updatedBy !== updatedBy || state.source !== "promote-prepare") throw new Error("promotion_superseded");
  const next: ReleaseState = {
    ...state,
    updatedAt,
    prePromotionBackup: { key, operationId: updatedBy, release: state.activeRelease, recordedAt: updatedAt },
  };
  releaseStateDocument(next);
  return next;
}

export function restorePromotion(
  state: ReleaseState,
  previous: ReleaseState,
  updatedAt: string,
  updatedBy: string,
): ReleaseState {
  if (state.worldId !== previous.worldId || state.generationId !== previous.generationId) throw new Error("promotion_world_changed");
  if (state.updatedBy !== updatedBy || state.source !== "promote-prepare") throw new Error("promotion_superseded");
  return changed(state, {
    desiredRelease: previous.desiredRelease,
    activeRelease: previous.activeRelease,
    source: "promote-refused",
  }, updatedAt, updatedBy);
}

export function rollbackPromotion(state: ReleaseState, updatedAt: string, updatedBy: string): ReleaseState {
  if (state.activeRelease === null) throw new Error("no_active_release_to_rollback");
  if (state.updatedBy !== updatedBy || state.source !== "promote-prepare") throw new Error("promotion_superseded");
  return changed(state, {
    desiredRelease: state.activeRelease,
    activeRelease: state.activeRelease,
    source: "promote-rollback",
  }, updatedAt, updatedBy);
}
