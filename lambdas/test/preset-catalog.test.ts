import assert from "node:assert/strict";
import test from "node:test";

import { parsePresetCatalog } from "../src/control-plane/preset-catalog.ts";
import { catalogWithPresets, gameCatalog } from "../src/control-plane/catalog.ts";
import { newWorldRecord } from "../src/control-plane/world-registry.ts";

const document = {
  schema_version: 2,
  game: "factorio",
  source: {
    repository: "https://github.com/DrArzter/my-docker-factorio-server-config",
    commit: "e0dd90cbbf721ab94f5dca403e2ca16599b8b28f",
  },
  presets: [{
    id: "factorio-vanilla",
    display_name: "Factorio vanilla 2.0",
    profile_digest: "1".repeat(64),
    build_status: "ready",
    releases: ["1.0"],
    latest_release: "1.0",
  }],
};

test("parses a versioned per-game preset catalog", () => {
  assert.deepEqual(parsePresetCatalog(document, "factorio"), [{
    id: "factorio-vanilla",
    displayName: "Factorio vanilla 2.0",
    gameId: "factorio",
    repository: document.source.repository,
    commit: document.source.commit,
    profileDigest: "1".repeat(64),
    releases: ["1.0"],
    buildStatus: "ready",
    latestRelease: "1.0",
  }]);
});

test("a ready preset remains reusable after several worlds are materialized", () => {
  const preset = parsePresetCatalog({
    ...document,
    presets: [{ id: "space-age", display_name: "Space Age", profile_digest: "2".repeat(64), build_status: "ready", releases: ["2.0"], latest_release: "2.0" }],
  }, "factorio")![0]!;
  const empty = catalogWithPresets([preset], gameCatalog).find((game) => game.id === "factorio")!;
  assert.deepEqual(empty.worlds, []);
  assert.equal(empty.presets?.[0]?.id, "space-age");

  const first = newWorldRecord(preset, { worldId: "factorio-rostik-a1b2c3d4", displayName: "Rostik", release: "2.0" }, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const second = newWorldRecord(preset, { worldId: "factorio-gosha-b1c2d3e4", displayName: "Gosha", release: "2.0" }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "2026-09-07T19:00:00.000Z");
  const materialized = catalogWithPresets([preset], gameCatalog, [first, second]).find((game) => game.id === "factorio")!;
  assert.deepEqual(materialized.worlds.map((world) => world.displayName), ["Rostik", "Gosha"]);
  assert.ok(materialized.worlds.every((world) => world.sessionControl === "v1" && world.worldLifecycle === "v1"));
  assert.equal(materialized.presets?.length, 1, "creating worlds never consumes the preset");

  const archived = { ...first, status: "archived" as const };
  const afterArchive = catalogWithPresets([preset], gameCatalog, [archived])
    .find((game) => game.id === "factorio")!.worlds;
  const archivedWorld = afterArchive.find((world) => world.profileId === preset.id)!;
  assert.equal(archivedWorld.materialization, "archived");
  assert.equal(archivedWorld.sessionControl, null);
  assert.equal(archivedWorld.worldLifecycle, "v1");
  assert.equal(afterArchive.filter((world) => world.profileId === preset.id).length, 1);
});

test("rejects a catalog for another game, duplicate ids, and ready presets without releases", () => {
  assert.equal(parsePresetCatalog(document, "minecraft"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [document.presets[0], document.presets[0]] }, "factorio"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [{ ...document.presets[0], latest_release: null }] }, "factorio"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [{ ...document.presets[0], releases: [] }] }, "factorio"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [{ ...document.presets[0], releases: ["1.0", "1.0"] }] }, "factorio"), null);
});

test("exposes preset build readiness without projecting presets into worlds", () => {
  const parsed = parsePresetCatalog({
    ...document,
    presets: [
      document.presets[0],
      { id: "space-age", display_name: "Space Age", profile_digest: "2".repeat(64), build_status: "unbuilt", releases: [], latest_release: null },
    ],
  }, "factorio")!;
  const catalog = catalogWithPresets(parsed, gameCatalog);
  const factorio = catalog.find((game) => game.id === "factorio")!;
  assert.deepEqual(factorio.worlds, []);
  assert.deepEqual(factorio.presets?.map((preset) => [preset.id, preset.buildStatus, preset.latestRelease]), [
    ["factorio-vanilla", "ready", "1.0"],
    ["space-age", "unbuilt", null],
  ]);
});
