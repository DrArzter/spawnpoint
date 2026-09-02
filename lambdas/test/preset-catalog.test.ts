import assert from "node:assert/strict";
import test from "node:test";

import { parsePresetCatalog } from "../src/control-plane/preset-catalog.ts";
import { catalogWithPresets, gameCatalog } from "../src/control-plane/catalog.ts";

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

test("rejects a catalog for another game, duplicate ids, and ready presets without releases", () => {
  assert.equal(parsePresetCatalog(document, "minecraft"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [document.presets[0], document.presets[0]] }, "factorio"), null);
  assert.equal(parsePresetCatalog({ ...document, presets: [{ ...document.presets[0], latest_release: null }] }, "factorio"), null);
});

test("enriches an existing profile and exposes a new preset without making it startable", () => {
  const parsed = parsePresetCatalog({
    ...document,
    presets: [
      document.presets[0],
      { id: "space-age", display_name: "Space Age", profile_digest: "2".repeat(64), build_status: "unbuilt", latest_release: null },
    ],
  }, "factorio")!;
  const catalog = catalogWithPresets(parsed, gameCatalog);
  const factorio = catalog.find((game) => game.id === "factorio")!;
  const existing = factorio.worlds.find((world) => world.profileId === "factorio-vanilla")!;
  const discovered = factorio.worlds.find((world) => world.id === "space-age")!;

  assert.equal(existing.materialization, "existing");
  assert.equal(existing.preset?.commit, document.source.commit);
  assert.equal(discovered.materialization, "not_created");
  assert.equal(discovered.sessionControl, null);
});
