import assert from "node:assert/strict";
import test from "node:test";

import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import {
  archiveWorldRecord, newWorldRecord, parseWorldRecord, regenerateWorldRecord,
  purgeGenerationIds, restoreWorldRecord, withWorldAccess, worldIdForName, worldRecordDocument,
} from "../src/control-plane/world-registry.ts";

const preset: PresetObservation = {
  id: "creative", displayName: "Creative", gameId: "minecraft",
  repository: "https://github.com/DrArzter/config", commit: "a".repeat(40), profileDigest: "b".repeat(64),
  buildStatus: "ready", releases: ["42.7"], latestRelease: "42.7",
};
const identity = { worldId: "minecraft-creative-a1b2c3d4", displayName: "Rostik's world", release: "42.7" };

test("preset, world and generation identities stay distinct", () => {
  const record = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(record.preset.id, "creative");
  assert.equal(record.worldId, identity.worldId);
  assert.equal(record.displayName, identity.displayName);
  assert.equal(record.currentGeneration.id, "gen-123456781234123412341234567890ab");
  assert.deepEqual(parseWorldRecord(worldRecordDocument(record)), record);
});

test("world ids are generated from a display name and independent identity", () => {
  const generated = worldIdForName("minecraft", "Rostik's Industrial World", "12345678-1234-1234-1234-1234567890ab");
  assert.match(generated, /^minecraft-rostik-s-indu-[0-9a-f]{8}$/);
  assert.equal(generated.length <= 32, true);
  assert.equal(worldIdForName("minecraft", "Мир Ростика", "12345678-1234-1234-1234-1234567890ab"), "minecraft-world-12345678");
});

test("an unbuilt preset cannot create a world", () => {
  assert.throws(() => newWorldRecord({ ...preset, buildStatus: "unbuilt", latestRelease: null }, identity, "12345678-1234-1234-1234-1234567890ab", new Date().toISOString()), /invalid_world_creation/);
});

test("world creation keeps connectivity independent and requires explicit public auth", () => {
  const args = [preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z"] as const;
  assert.throws(() => newWorldRecord(...args, { connectivity: "route53" }), /invalid_world_connectivity/);
  const named = newWorldRecord(...args, { connectivity: "route53", auth: "external" });
  assert.deepEqual(parseWorldRecord(worldRecordDocument(named)), named);
});

test("hosting and connection can change without changing the world generation", () => {
  const original = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const fleet = withWorldAccess(original, { placement: "fleet", connectivity: "route53", auth: "game" });
  assert.equal(fleet.currentGeneration, original.currentGeneration);
  assert.deepEqual(parseWorldRecord(worldRecordDocument(fleet)), fleet);
  assert.deepEqual(withWorldAccess(fleet, { placement: "configured", connectivity: "zerotier" }), original);
  assert.throws(() => withWorldAccess(original, { placement: "fleet", connectivity: "zerotier" }), /invalid_world_connectivity/);
});

test("registry parsing fails closed", () => {
  const record = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const document = worldRecordDocument(record);
  assert.equal(parseWorldRecord({ ...document, world_id: "../escape" }), null);
  assert.equal(parseWorldRecord({ ...document, storage_layout: "legacy" }), null);
  const { placement: _placement, ...legacyDocument } = document;
  assert.deepEqual(parseWorldRecord({ ...legacyDocument, connectivity: "route53", auth: "external" }), {
    ...record, placement: "fleet", connectivity: "route53", auth: "external",
  });
  assert.equal(parseWorldRecord({ ...document, connectivity: "route53" }), null);
  assert.equal(parseWorldRecord({ ...document, connectivity: "route53", auth: "none" }), null);
});

test("regeneration closes the old generation and never overwrites it", () => {
  const record = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const next = regenerateWorldRecord(record, { ...preset, releases: ["42.7", "43.1"], latestRelease: "43.1" }, "43.1", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-08T10:00:00.000Z");

  assert.equal(next.currentGeneration.id, "gen-aaaaaaaabbbbccccddddeeeeeeeeeeee");
  assert.equal(next.currentGeneration.release, "43.1");
  assert.equal(next.previousGenerations[0]?.id, record.currentGeneration.id);
  assert.equal(next.previousGenerations[0]?.closedAt, "2026-09-08T10:00:00.000Z");
  assert.deepEqual(parseWorldRecord(worldRecordDocument(next)), next);
});

test("restore creates a new generation pinned to the backup generation's release", () => {
  const initial = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
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
  const record = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.throws(() => restoreWorldRecord(record, {
    key: `worlds/${record.worldId}/archives/world-gen-${"f".repeat(32)}-20260908T090000Z-${"c".repeat(64)}.tar.zst`,
    checksum: "c".repeat(64),
    generationId: `gen-${"f".repeat(32)}`,
  }, "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb", "2026-09-08T11:00:00.000Z"), /backup_generation_unknown/);
});

test("purge is possible only after archive and names every generation to clean", () => {
  const initial = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const regenerated = regenerateWorldRecord(initial, preset, "42.7", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-08T10:00:00.000Z");
  assert.throws(() => purgeGenerationIds(regenerated), /world_not_archived/);
  assert.deepEqual(purgeGenerationIds(archiveWorldRecord(regenerated)), [
    regenerated.currentGeneration.id,
    initial.currentGeneration.id,
  ]);
});
