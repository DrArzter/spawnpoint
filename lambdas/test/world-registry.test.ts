import assert from "node:assert/strict";
import test from "node:test";

import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import {
  archiveWorldRecord, newWorldRecord, parseWorldRecord, regenerateWorldRecord,
  purgeGenerationIds, restoreWorldRecord, translateWorldDocument, withGameSettings, withConfigFiles, withWhitelist, withWorldAccess, worldIdForName, worldRecordDocument,
  WORLD_RECORD_TRANSLATIONS,
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
  assert.throws(() => newWorldRecord({ ...preset, releases: [], buildStatus: "unbuilt", latestRelease: null }, identity, "12345678-1234-1234-1234-1234567890ab", new Date().toISOString()), /invalid_world_creation/);
});

test("a failed later build does not invalidate an already published release", () => {
  assert.doesNotThrow(() => newWorldRecord({ ...preset, buildStatus: "failed" }, identity, "12345678-1234-1234-1234-1234567890ab", new Date().toISOString()));
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

test("a world on the persistent host may use a public address or DNS, with the game's own login (ADR-0085)", () => {
  const args = [preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z"] as const;
  const original = newWorldRecord(...args);
  for (const connectivity of ["raw", "route53"] as const) {
    const persistent = withWorldAccess(original, { placement: "configured", connectivity, auth: "game" });
    assert.equal(persistent.placement, "configured");
    assert.equal(persistent.connectivity, connectivity);
    assert.deepEqual(parseWorldRecord(worldRecordDocument(persistent)), persistent, "the record keeps the choice");
    assert.throws(() => withWorldAccess(original, { placement: "configured", connectivity }), /invalid_world_connectivity/, "a public world declares its login");
  }
  const created = newWorldRecord(...args, { placement: "configured", connectivity: "raw", auth: "game" });
  assert.equal(created.placement, "configured");
  assert.deepEqual(parseWorldRecord(worldRecordDocument(created)), created);
});

test("a fleet world can keep its host warm; the choice survives other hosting changes and leaves with the fleet", () => {
  const original = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(original.warm, undefined, "a new world is cold");
  assert.equal("warm" in worldRecordDocument(original), false, "a cold record keeps its document unchanged");

  const warm = withWorldAccess(original, { placement: "fleet", connectivity: "raw", auth: "game", warm: true });
  assert.equal(warm.warm, true);
  assert.equal(worldRecordDocument(warm).warm, true);
  assert.deepEqual(parseWorldRecord(worldRecordDocument(warm)), warm);

  assert.equal(withWorldAccess(warm, { placement: "fleet", connectivity: "route53", auth: "game" }).warm, true, "left out: kept");
  assert.equal(withWorldAccess(warm, { placement: "fleet", connectivity: "raw", auth: "game", warm: false }).warm, undefined);
  assert.deepEqual(withWorldAccess(warm, { placement: "configured", connectivity: "zerotier" }), original);
  assert.throws(() => withWorldAccess(original, { placement: "configured", connectivity: "zerotier", warm: true }), /invalid_world_warm/);
});

test("the record parser reads warm as a boolean and nothing else", () => {
  const fleet = withWorldAccess(
    newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z"),
    { placement: "fleet", connectivity: "raw", auth: "game" },
  );
  const document = worldRecordDocument(fleet);
  assert.deepEqual(parseWorldRecord({ ...document, warm: true }), { ...fleet, warm: true });
  assert.deepEqual(parseWorldRecord({ ...document, warm: false }), fleet);
  assert.equal(parseWorldRecord({ ...document, warm: "yes" }), null);
  assert.equal(parseWorldRecord({ ...document, warm: 1 }), null);
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

test("a world's game settings round-trip and outlive its wipes, restores and archive (ADR-0064)", () => {
  const original = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(original.gameSettings, undefined, "a new world sets nothing");
  assert.equal("game_settings" in worldRecordDocument(original), false);
  const gameSettings = {
    values: { difficulty: "hard", max_players: 8, pvp: false },
    updatedAt: "2026-10-09T11:00:00.000Z",
    updatedBy: { identityId: "identity-owner", displayName: "DrArzter" },
  };
  const set = withGameSettings(original, gameSettings);
  assert.deepEqual(parseWorldRecord(worldRecordDocument(set)), set);
  const wiped = regenerateWorldRecord(set, preset, "42.7", "22345678-1234-1234-1234-1234567890ab", "2026-10-09T12:00:00.000Z");
  assert.deepEqual(wiped.gameSettings, gameSettings, "a new wipe keeps the world's settings");
  assert.deepEqual(archiveWorldRecord(set).gameSettings, gameSettings);
  const backup = { key: `worlds/${identity.worldId}/archives/${identity.worldId}-gen-123456781234123412341234567890ab-20260909T000000Z-${"c".repeat(64)}.tar.zst`, checksum: "c".repeat(64), generationId: "gen-123456781234123412341234567890ab" };
  assert.deepEqual(restoreWorldRecord(wiped, backup, "32345678-1234-1234-1234-1234567890ab", "2026-10-09T13:00:00.000Z").gameSettings, gameSettings);

  const document = worldRecordDocument(set) as Record<string, Record<string, unknown>>;
  const settingsDocument = document.game_settings!;
  assert.equal(parseWorldRecord({ ...document, game_settings: { ...settingsDocument, values: { "Max Players": 8 } } }), null);
  assert.equal(parseWorldRecord({ ...document, game_settings: { ...settingsDocument, values: { max_players: [8] } } }), null);
  assert.equal(parseWorldRecord({ ...document, game_settings: { ...settingsDocument, updated_by: null } }), null);
});

test("a world's whitelist round-trips, outlives its wipes and restores, and holds only names (ADR-0066)", () => {
  const original = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(original.whitelist, undefined, "a new world keeps no whitelist; its server's own file is left alone");
  const whitelist = { names: ["DrArzter", "Mira"], updatedAt: "2026-10-09T11:00:00.000Z", updatedBy: { identityId: "identity-owner", displayName: "DrArzter" } };
  const kept = withWhitelist(original, whitelist);
  assert.deepEqual(parseWorldRecord(worldRecordDocument(kept)), kept);
  const empty = withWhitelist(original, { ...whitelist, names: [] });
  assert.deepEqual(parseWorldRecord(worldRecordDocument(empty))?.whitelist?.names, [], "an empty list is kept, not dropped");
  const wiped = regenerateWorldRecord(kept, preset, "42.7", "22345678-1234-1234-1234-1234567890ab", "2026-10-09T12:00:00.000Z");
  assert.deepEqual(wiped.whitelist, whitelist, "a new wipe keeps the world's players");

  const document = worldRecordDocument(kept) as Record<string, Record<string, unknown>>;
  const whitelistDocument = document.whitelist!;
  assert.equal(parseWorldRecord({ ...document, whitelist: { ...whitelistDocument, names: ["has space"] } }), null);
  assert.equal(parseWorldRecord({ ...document, whitelist: { ...whitelistDocument, names: ["DrArzter", "drarzter"] } }), null);
  assert.equal(parseWorldRecord({ ...document, whitelist: { ...whitelistDocument, updated_by: null } }), null);
});

test("a world's config files round-trip, outlive its wipes and hold only paths inside the roots (ADR-0093)", () => {
  const original = newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  assert.equal(original.configFiles, undefined);
  const edit = { sha256: "a".repeat(64), bytes: 16, baseSha256: "b".repeat(64), updatedAt: "2026-11-24T12:00:00.000Z", updatedBy: { identityId: "identity-owner", displayName: "DrArzter" } };
  const kept = withConfigFiles(original, { "config/claims.toml": edit, "kubejs/server_scripts/new.js": { ...edit, baseSha256: null } });
  assert.deepEqual(parseWorldRecord(worldRecordDocument(kept)), kept);
  assert.equal(withConfigFiles(kept, {}).configFiles, undefined, "no edits leave no field");
  const wiped = regenerateWorldRecord(kept, preset, "42.7", "22345678-1234-1234-1234-1234567890ab", "2026-11-24T13:00:00.000Z");
  assert.deepEqual(wiped.configFiles, kept.configFiles, "a new wipe keeps the world's edits");
  const document = worldRecordDocument(kept) as Record<string, Record<string, unknown>>;
  assert.equal(parseWorldRecord({ ...document, config_files: { "ops.json": document.config_files!["config/claims.toml"] } }), null);
  assert.equal(parseWorldRecord({ ...document, config_files: { "config/a.toml": { ...(document.config_files!["config/claims.toml"] as object), sha256: "x" } } }), null);
});

// ADR-0097: a record keeps the shape it was written in; the reader lifts it.
test("a record written before placements reads as the placement its connection meant, and is written back in the newest shape", () => {
  // The shape of the first world's record in production, written in 2026-08.
  const stored = {
    schema_version: 1, world_id: "world", game: "minecraft", display_name: "Main modded", status: "active",
    connectivity: "zerotier", storage_layout: "generation",
    preset: { id: "main", repository: "https://github.com/DrArzter/config", commit: "c".repeat(40), profile_digest: "d".repeat(64) },
    current_generation: { id: `gen-${"e".repeat(32)}`, release: "1.1", created_at: "2026-08-26T16:39:31.469Z", source: { kind: "preset" } },
    previous_generations: [],
  };
  assert.deepEqual(translateWorldDocument(stored).applied, ["placement-from-connectivity"]);
  const record = parseWorldRecord(stored);
  assert.equal(record?.placement, "configured");
  assert.equal(worldRecordDocument(record!).placement, "configured", "a writer writes the newest shape");
  assert.deepEqual(translateWorldDocument(worldRecordDocument(record!)).applied, [], "the newest shape needs no translation");
  const publicWorld = parseWorldRecord({ ...stored, connectivity: "raw", auth: "game" });
  assert.equal(publicWorld?.placement, "fleet", "before ADR-0085 a public world ran on the fleet");
});

test("every translation is named once, and a new record needs none", () => {
  const names = WORLD_RECORD_TRANSLATIONS.map((translation) => translation.name);
  assert.equal(new Set(names).size, names.length);
  const created = worldRecordDocument(newWorldRecord(preset, identity, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z"));
  for (const translation of WORLD_RECORD_TRANSLATIONS) {
    assert.equal(translation.applies(created), false, `${translation.name}: a new record needs no translation`);
  }
});
