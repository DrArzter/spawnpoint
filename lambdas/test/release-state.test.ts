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

