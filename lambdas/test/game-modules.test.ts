import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { gameFootprints, gameCatalog } from "../src/control-plane/catalog.ts";
import { gameModules } from "../src/control-plane/game-modules.ts";
import { gameSettingDefinitions } from "../src/control-plane/game-settings.ts";

// ADR-0088: a game module is one folder; the Lambdas list each folder once and
// read every fact from its manifest.

const games = new URL("../../server/games/", import.meta.url);

async function exists(url: URL): Promise<boolean> {
  return access(url).then(() => true, () => false);
}

test("every game module folder is listed once, with its settings when it has them", async () => {
  const folders = (await readdir(games, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual([...gameModules.map((module) => module.id)].sort(), folders);
  for (const id of folders) {
    const hasSettings = await exists(new URL(`${id}/settings.json`, games));
    assert.equal(gameSettingDefinitions(id).length > 0, hasSettings, `${id}: settings.json and the registry disagree`);
  }
});

test("the catalog and the footprints are the manifests' facts", () => {
  for (const module of gameModules) {
    const game = gameCatalog.find((candidate) => candidate.id === module.id);
    assert.ok(game, `${module.id} is missing from the catalog`);
    assert.equal(game.connectPort, module.connectPort);
    assert.equal(game.slottable !== false, module.slottable);
    assert.equal(game.whitelist === true, module.whitelist);
    assert.deepEqual(gameFootprints[module.id], module.footprint);
    assert.deepEqual(game.presentation, module.presentation);
  }
});

test("one module owns the records that name no game, and no Lambda source names a game", async () => {
  const { LEGACY_GAME_ID } = await import("../src/control-plane/game-modules.ts");
  assert.deepEqual(gameModules.filter((module) => module.legacyDefault).map((module) => module.id), [LEGACY_GAME_ID]);
  const { readdir, readFile } = await import("node:fs/promises");
  const source = new URL("../src/", import.meta.url);
  const ids = gameModules.map((module) => module.id).join("|");
  const literal = new RegExp(`["'\`](${ids})["'\`]`);
  for (const name of (await readdir(source, { recursive: true })).filter((file) => file.endsWith(".ts"))) {
    const text = await readFile(new URL(name, source), "utf8");
    assert.doesNotMatch(text, literal, `${name} names a game; read it from the game's module instead (ADR-0088)`);
  }
});

test("every manifest states whether its game may run on Spot (ADR-0102)", async () => {
  for (const module of gameModules) {
    const manifest = JSON.parse(await readFile(new URL(`${module.id}/game.json`, games), "utf8")) as { capabilities: Record<string, unknown> };
    assert.equal(typeof manifest.capabilities.spot, "boolean", `${module.id}: capabilities.spot is not stated`);
    assert.equal(module.spot, manifest.capabilities.spot);
  }
});

test("a module names its look, and one with no presentation names none", () => {
  for (const module of gameModules) {
    for (const name of [module.presentation.tint, module.presentation.glyph, module.presentation.scene]) {
      assert.ok(name === null || /^[a-z][a-z-]{0,31}$/.test(name), `${module.id}: ${name}`);
    }
  }
  assert.ok(gameModules.some((module) => module.presentation.scene === null), "a module without a presentation falls back to the skins' defaults");
});
