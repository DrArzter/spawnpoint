import assert from "node:assert/strict";
import test from "node:test";

import { parsePresetCatalog } from "../src/control-plane/preset-catalog.ts";
import { catalogWithPresets, gameCatalog } from "../src/control-plane/catalog.ts";
import { newWorldRecord } from "../src/control-plane/world-registry.ts";

const document = {
  schema_version: 1,
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
    buildStatus: "ready",
    latestRelease: "1.0",
  }]);
});

test("a ready preset becomes a startable candidate and then a materialized world", () => {
  const preset = parsePresetCatalog({
    ...document,
    presets: [{ id: "space-age", display_name: "Space Age", profile_digest: "2".repeat(64), build_status: "ready", latest_release: "2.0" }],
  }, "factorio")![0]!;
  const candidate = catalogWithPresets([preset], gameCatalog)
    .find((game) => game.id === "factorio")!.worlds.find((world) => world.id === "factorio-space-age")!;
  assert.equal(candidate.materialization, "not_created");
  assert.equal(candidate.sessionControl, "v1");

  const record = newWorldRecord(preset, "12345678-1234-1234-1234-1234567890ab", "2026-09-07T18:00:00.000Z");
  const materialized = catalogWithPresets([preset], gameCatalog, [record])
    .find((game) => game.id === "factorio")!.worlds.find((world) => world.id === "factorio-space-age")!;
  assert.equal(materialized.materialization, "existing");
  assert.equal(materialized.sessionControl, "v1");
  assert.equal(materialized.worldLifecycle, "v1");

  const archived = { ...record, status: "archived" as const };
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
});

test("exposes only ready unmaterialized presets as startable", () => {
  const parsed = parsePresetCatalog({
    ...document,
    presets: [
      document.presets[0],
      { id: "space-age", display_name: "Space Age", profile_digest: "2".repeat(64), build_status: "unbuilt", latest_release: null },
    ],
  }, "factorio")!;
  const catalog = catalogWithPresets(parsed, gameCatalog);
  const factorio = catalog.find((game) => game.id === "factorio")!;
  const ready = factorio.worlds.find((world) => world.profileId === "factorio-vanilla")!;
  const discovered = factorio.worlds.find((world) => world.id === "factorio-space-age")!;

  assert.equal(ready.id, "factorio-vanilla");
  assert.equal(ready.materialization, "not_created");
  assert.equal(ready.sessionControl, "v1");
  assert.equal(ready.preset?.commit, document.source.commit);
  assert.equal(discovered.materialization, "not_created");
  assert.equal(discovered.sessionControl, null);
});
