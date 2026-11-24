import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
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
  }
});
