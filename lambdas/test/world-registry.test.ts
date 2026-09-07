import assert from "node:assert/strict";
import test from "node:test";

import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import { newWorldRecord, parseWorldRecord, worldIdForPreset, worldRecordDocument } from "../src/control-plane/world-registry.ts";

const preset: PresetObservation = {
  id: "creative", displayName: "Creative", gameId: "minecraft",
  repository: "https://github.com/DrArzter/config", commit: "a".repeat(40), profileDigest: "b".repeat(64),
  buildStatus: "ready", latestRelease: "42.7",
};

test("preset, world and generation identities stay distinct", () => {
  const record = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(record.preset.id, "creative");
  assert.equal(record.worldId, "minecraft-creative");
  assert.equal(record.currentGeneration.id, "gen-123456781234123412341234567890ab");
  assert.deepEqual(parseWorldRecord(worldRecordDocument(record)), record);
});

test("long preset ids produce stable bounded world ids", () => {
  const long = { ...preset, id: "a-very-long-preset-identifier" };
  assert.equal(worldIdForPreset(long).length <= 32, true);
  assert.equal(worldIdForPreset(long), worldIdForPreset(long));
});

test("a preset already namespaced by its game is not prefixed twice", () => {
  assert.equal(worldIdForPreset({ ...preset, gameId: "factorio", id: "factorio-vanilla" }), "factorio-vanilla");
});

test("an unbuilt preset cannot create a world", () => {
  assert.throws(() => newWorldRecord({ ...preset, buildStatus: "unbuilt", latestRelease: null }, "12345678-1234-1234-1234-1234567890ab", new Date().toISOString()), /preset_release_not_ready/);
});

test("registry parsing fails closed", () => {
  const record = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const document = worldRecordDocument(record);
  assert.equal(parseWorldRecord({ ...document, world_id: "../escape" }), null);
  assert.equal(parseWorldRecord({ ...document, storage_layout: "legacy" }), null);
});
