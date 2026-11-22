import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyReleaseStateKey, parseLegacyReleaseState, parseReleaseState, releaseStateDocument, releaseStateKey,
  type ReleaseState,
} from "../src/control-plane/release-state.ts";

const ref = { worldId: "minecraft-rostik-a1b2c3d4", generationId: `gen-${"a".repeat(32)}` };
const state: ReleaseState = {
  ...ref,
  desiredRelease: "2.1",
  activeRelease: "2.0",
  updatedAt: "2026-09-10T12:00:00.000Z",
  updatedBy: "identity:test",
  source: "promote",
};

test("generation-scoped keys are the only canonical release-state location", () => {
  assert.equal(releaseStateKey(ref), `worlds/${ref.worldId}/generations/${ref.generationId}/release.json`);
  assert.equal(legacyReleaseStateKey(ref.worldId), `worlds/${ref.worldId}/release.json`);
});

test("release state round-trips and rejects another wipe", () => {
  const document = releaseStateDocument(state);
  assert.deepEqual(parseReleaseState(document, ref), state);
  assert.equal(parseReleaseState(document, { ...ref, generationId: `gen-${"b".repeat(32)}` }), null);
});

test("legacy pointers can only be imported with an explicit generation identity", () => {
  const migrated = parseLegacyReleaseState({
    schema_version: 1,
    world: ref.worldId,
    desired_release: "1.2",
    active_release: "1.1",
  }, ref, "2026-09-10T12:00:00.000Z");
  assert.deepEqual(migrated, {
    ...ref,
    desiredRelease: "1.2",
    activeRelease: "1.1",
    updatedAt: "2026-09-10T12:00:00.000Z",
    updatedBy: "legacy-pointer-migration",
    source: "migration",
  });
  assert.equal(parseLegacyReleaseState({ schema_version: 1, world: "another" }, ref, state.updatedAt), null);
});


test("the releases a wipe ran and its pre-promotion backup round-trip on the pointer", () => {
  const archive = `worlds/${ref.worldId}/archives/${ref.worldId}-${ref.generationId}-20260910T120000Z-${"c".repeat(64)}.tar.zst`;
  const recorded: ReleaseState = {
    ...state,
    releasesRun: [{ release: "2.0", since: "2026-09-01T00:00:00.000Z" }],
    prePromotionBackup: { key: archive, operationId: "op-1", release: "2.0", recordedAt: "2026-09-10T12:00:00.000Z" },
  };
  const document = releaseStateDocument(recorded);
  assert.deepEqual(document.releases_run, [{ release: "2.0", since: "2026-09-01T00:00:00.000Z" }]);
  assert.deepEqual(parseReleaseState(document, ref), recorded);
  // A pointer written before runs were recorded reads as before and writes nothing new.
  assert.equal("releases_run" in releaseStateDocument(state), false);
});

test("a pre-promotion backup of another wipe or a malformed run makes the pointer invalid", () => {
  const document = releaseStateDocument(state);
  const otherWipe = `worlds/${ref.worldId}/archives/${ref.worldId}-gen-${"b".repeat(32)}-20260910T120000Z-${"c".repeat(64)}.tar.zst`;
  assert.equal(parseReleaseState({ ...document, pre_promotion_backup: { key: otherWipe, operation_id: "op", release: null, recorded_at: "2026-09-10T12:00:00Z" } }, ref), null);
  assert.equal(parseReleaseState({ ...document, releases_run: [{ release: "latest", since: "2026-09-10T12:00:00Z" }] }, ref), null);
  assert.throws(() => releaseStateDocument({ ...state, prePromotionBackup: { key: otherWipe, operationId: "op", release: null, recordedAt: "2026-09-10T12:00:00Z" } }), /invalid_release_state/);
});
