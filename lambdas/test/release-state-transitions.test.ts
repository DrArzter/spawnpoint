import assert from "node:assert/strict";
import test from "node:test";

import {
  commitPromotion, preparePromotion, restorePromotion, rollbackPromotion,
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
