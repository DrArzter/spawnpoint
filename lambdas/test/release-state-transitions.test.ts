import assert from "node:assert/strict";
import test from "node:test";

import {
  commitPromotion, preparePromotion, recordPrePromotionBackup, restorePromotion, rollbackPromotion,
} from "../src/control-plane/release-state-transitions.ts";
import type { ReleaseState } from "../src/control-plane/release-state.ts";

const initial: ReleaseState = {
  worldId: "factory", generationId: `gen-${"a".repeat(32)}`,
  desiredRelease: "1.1", activeRelease: "1.1",
  updatedAt: "2026-09-01T00:00:00.000Z", updatedBy: "initial", source: "create-world",
};

test("promotion transitions preserve the world and wipe identity", () => {
  const prepared = preparePromotion(initial, "1.2", "2026-09-02T00:00:00.000Z", "op-1");
  const committed = commitPromotion(prepared, "1.2", "2026-09-02T00:01:00.000Z", "op-1");
  assert.equal(committed.worldId, initial.worldId);
  assert.equal(committed.generationId, initial.generationId);
  assert.equal(committed.activeRelease, "1.2");
  assert.equal(committed.desiredRelease, "1.2");
});

test("a refused stop restores the exact state observed before prepare", () => {
  const prepared = preparePromotion(initial, "1.2", "2026-09-02T00:00:00.000Z", "op-1");
  const restored = restorePromotion(prepared, initial, "2026-09-02T00:01:00.000Z", "op-1");
  assert.equal(restored.desiredRelease, "1.1");
  assert.equal(restored.activeRelease, "1.1");
});

test("rollback selects the previously active release and refuses a stale promotion", () => {
  const prepared = preparePromotion(initial, "1.2", "2026-09-02T00:00:00.000Z", "op-1");
  assert.equal(rollbackPromotion(prepared, "2026-09-02T00:01:00.000Z", "op-1").desiredRelease, "1.1");
  assert.throws(() => rollbackPromotion(prepared, "2026-09-02T00:01:00.000Z", "op-2"), /promotion_superseded/);
});

test("each commit records the release the wipe ran from then on, once per change", () => {
  const first = commitPromotion(initial, "1.1", "2026-09-01T01:00:00.000Z", "start-1");
  assert.deepEqual(first.releasesRun, [{ release: "1.1", since: "2026-09-01T01:00:00.000Z" }]);
  const again = commitPromotion(first, "1.1", "2026-09-01T02:00:00.000Z", "start-2");
  assert.deepEqual(again.releasesRun, first.releasesRun);
  const promoted = commitPromotion(preparePromotion(again, "1.2", "2026-09-02T00:00:00.000Z", "op-1"), "1.2", "2026-09-02T00:01:00.000Z", "op-1");
  assert.deepEqual(promoted.releasesRun?.map((run) => run.release), ["1.1", "1.2"]);
  // A refused or rolled-back promotion keeps the runs: nothing new ran.
  const prepared = preparePromotion(promoted, "1.3", "2026-09-03T00:00:00.000Z", "op-2");
  assert.deepEqual(rollbackPromotion(prepared, "2026-09-03T00:01:00.000Z", "op-2").releasesRun, promoted.releasesRun);
  assert.deepEqual(restorePromotion(prepared, promoted, "2026-09-03T00:01:00.000Z", "op-2").releasesRun, promoted.releasesRun);
});

test("only the promotion that prepared the pointer records its backup, and it still owns the pointer after", () => {
  const archive = `worlds/factory/archives/factory-${initial.generationId}-20260902T000000Z-${"c".repeat(64)}.tar.zst`;
  const prepared = preparePromotion(initial, "1.2", "2026-09-02T00:00:00.000Z", "op-1");
  const kept = recordPrePromotionBackup(prepared, archive, "2026-09-02T00:00:30.000Z", "op-1");
  assert.deepEqual(kept.prePromotionBackup, { key: archive, operationId: "op-1", release: "1.1", recordedAt: "2026-09-02T00:00:30.000Z" });
  assert.equal(rollbackPromotion(kept, "2026-09-02T00:01:00.000Z", "op-1").prePromotionBackup?.key, archive);
  assert.throws(() => recordPrePromotionBackup(prepared, archive, "2026-09-02T00:00:30.000Z", "op-2"), /promotion_superseded/);
  assert.throws(() => recordPrePromotionBackup(initial, archive, "2026-09-02T00:00:30.000Z", "initial"), /promotion_superseded/);
});
