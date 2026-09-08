import assert from "node:assert/strict";
import test from "node:test";

import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import {
  archiveWorldRecord, newWorldRecord, parseWorldRecord, regenerateWorldRecord,
  restoreWorldRecord, worldIdForPreset, worldRecordDocument,
} from "../src/control-plane/world-registry.ts";

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

test("regeneration closes the old generation and never overwrites it", () => {
  const record = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const next = regenerateWorldRecord(record, { ...preset, latestRelease: "43.1" }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-08T10:00:00.000Z");

  assert.equal(next.currentGeneration.id, "gen-aaaaaaaabbbbccccddddeeeeeeeeeeee");
  assert.equal(next.currentGeneration.release, "43.1");
  assert.equal(next.previousGenerations[0]?.id, record.currentGeneration.id);
  assert.equal(next.previousGenerations[0]?.closedAt, "2026-09-08T10:00:00.000Z");
  assert.deepEqual(parseWorldRecord(worldRecordDocument(next)), next);
});

test("restore creates a new generation pinned to the backup generation's release", () => {
  const initial = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const archived = archiveWorldRecord(initial);
  const checksum = "c".repeat(64);
  const restored = restoreWorldRecord(archived, {
    key: `worlds/${initial.worldId}/archives/${initial.worldId}-${initial.currentGeneration.id}-20260908T090000Z-${checksum}.tar.zst`,
    checksum,
    generationId: initial.currentGeneration.id,
  }, "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", "2026-09-08T11:00:00.000Z");

  assert.equal(restored.status, "active");
  assert.equal(restored.currentGeneration.release, initial.currentGeneration.release);
  assert.deepEqual(restored.currentGeneration.source, {
    kind: "backup",
    key: `worlds/${initial.worldId}/archives/${initial.worldId}-${initial.currentGeneration.id}-20260908T090000Z-${checksum}.tar.zst`,
    checksum,
    generationId: initial.currentGeneration.id,
  });
  assert.equal(restored.previousGenerations[0]?.id, initial.currentGeneration.id);
});

test("restore refuses a backup that cannot be tied to this world's generation history", () => {
  const record = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.throws(() => restoreWorldRecord(record, {
    key: `worlds/${record.worldId}/archives/world-gen-${"f".repeat(32)}-20260908T090000Z-${"c".repeat(64)}.tar.zst`,
    checksum: "c".repeat(64),
    generationId: `gen-${"f".repeat(32)}`,
  }, "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", "2026-09-08T11:00:00.000Z"), /backup_generation_unknown/);
});
