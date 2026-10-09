import assert from "node:assert/strict";
import test from "node:test";

import { catalogWithPresets, findCatalogWorld, gameCatalog } from "../src/control-plane/catalog.ts";
import { archiveWorldRecord, newWorldRecord } from "../src/control-plane/world-registry.ts";

// Inviting players names a world. Every world the panel lists must resolve,
// and most of them were created from a preset, so they live in the registry
// rather than in the built-in catalog, which knows only the legacy worlds.

const preset = {
  id: "minecraft-industrial", displayName: "Industrial", gameId: "minecraft",
  repository: "https://github.com/example/minecraft", commit: "1".repeat(40), profileDigest: "2".repeat(64),
  buildStatus: "ready", releases: ["1.2"], latestRelease: "1.2",
} as const;
const rostik = newWorldRecord(preset, { worldId: "minecraft-rostik-12345678", displayName: "Rostik", release: "1.2" }, "12345678-1234-1234-1234-1234567890ab", "2026-09-08T00:00:00.000Z");
const retired = archiveWorldRecord(newWorldRecord(preset, { worldId: "minecraft-old-87654321", displayName: "Old", release: "1.2" }, "87654321-1234-1234-1234-1234567890ab", "2026-09-01T00:00:00.000Z"));
const catalog = catalogWithPresets([preset], gameCatalog, [rostik, retired]);

test("a world created from a preset resolves, with its game and its own name", () => {
  const found = findCatalogWorld(catalog, "minecraft", rostik.worldId);
  assert.equal(found?.game.displayName, "Minecraft");
  assert.equal(found?.world.displayName, "Rostik");
  assert.equal(findCatalogWorld(gameCatalog, "minecraft", rostik.worldId), null, "the built-in catalog alone never knew it");
});

test("the legacy worlds still resolve, and an archived world says so", () => {
  assert.equal(findCatalogWorld(catalog, "minecraft", "world")?.world.id, "world");
  assert.equal(findCatalogWorld(catalog, "minecraft", retired.worldId)?.world.materialization, "archived");
});

test("a world of another game, or one nobody knows, does not resolve", () => {
  assert.equal(findCatalogWorld(catalog, "factorio", rostik.worldId), null);
  assert.equal(findCatalogWorld(catalog, "minecraft", "missing"), null);
  assert.equal(findCatalogWorld(catalog, "minecraft", preset.id), null, "a preset is not a world");
});
