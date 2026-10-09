import "./support/browser.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { gameSettingsPayload } from "../src/core/forms.ts";
import { changedSettings, settingsAvailable } from "../src/core/settings.ts";
import { worldDetails, worldMoreActions, type WorldCallbacks } from "../src/core/worlds.ts";
import { initialState, MINECRAFT_SETTINGS } from "../src/demo/data.ts";
import type { Game, World } from "../src/model.ts";

// ADR-0064: a world sets game settings from its game's reviewed list; the
// panel sends what the world sets and nothing it never touched.

test("the demo serves the game module's own definitions", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../server/games/minecraft/settings.json", import.meta.url), "utf8")) as { settings: Record<string, unknown>[] };
  const served = onDisk.settings.map(({ env: _env, max_length, ...setting }) => (max_length === undefined ? setting : { ...setting, maxLength: max_length }));
  assert.deepEqual(MINECRAFT_SETTINGS, served);
});

const defaults = Object.fromEntries(MINECRAFT_SETTINGS.map((setting) => [setting.id, setting.type === "boolean" ? setting.default : String(setting.default)]));

test("a save sends what the world sets and leaves untouched settings out", () => {
  assert.deepEqual(gameSettingsPayload(MINECRAFT_SETTINGS, {}, defaults), { values: {}, valid: true, changed: false, atDefaults: true });
  const hard = gameSettingsPayload(MINECRAFT_SETTINGS, {}, { ...defaults, difficulty: "hard", allow_flight: true, max_players: "8" });
  assert.deepEqual(hard.values, { difficulty: "hard", max_players: 8, allow_flight: true });
  assert.equal(hard.changed, true);
});

test("a setting once set stays set, so its default reaches the server too", () => {
  const stored = { difficulty: "hard", allow_flight: true };
  const back = gameSettingsPayload(MINECRAFT_SETTINGS, stored, { ...defaults });
  assert.deepEqual(back.values, { difficulty: "normal", allow_flight: false });
  assert.equal(back.changed, true);
  assert.equal(back.atDefaults, true);
  const same = gameSettingsPayload(MINECRAFT_SETTINGS, stored, { ...defaults, difficulty: "hard", allow_flight: true });
  assert.equal(same.changed, false, "nothing to save");
});

test("a draft the game would refuse makes the form invalid", () => {
  for (const draft of [{ max_players: "500" }, { max_players: "2.5" }, { max_players: "" }, { motd: "" }, { motd: "$(reboot)" }]) {
    assert.equal(gameSettingsPayload(MINECRAFT_SETTINGS, {}, { ...defaults, ...draft }).valid, false, JSON.stringify(draft));
  }
});

const demo = initialState().snapshot;
const minecraft = demo.games.find((game) => game.id === "minecraft") as unknown as Game;
const rostik = minecraft.worlds.find((world) => world.id === "minecraft-rostik-12345678")!;
const vanilla = minecraft.worlds.find((world) => world.id === "vanilla")!;
const callbacks: WorldCallbacks = { onWorldAction: () => undefined, onInvite: () => undefined, onDownloadPack: () => undefined, onEditSettings: () => undefined, onEditGameSettings: () => undefined };
const ids = (world: World, granted: readonly string[], withSettings = true) =>
  worldMoreActions(minecraft, world, new Set(granted), false, withSettings ? callbacks : { ...callbacks, onEditGameSettings: undefined } as WorldCallbacks).map((item) => item.id);

test("the world's overflow offers game settings only where they can be kept and changed", () => {
  assert.ok(ids(rostik, ["world.manage"]).includes("world.game-settings"));
  assert.ok(!ids(rostik, ["status.read"]).includes("world.game-settings"), "only world.manage changes them");
  assert.ok(!ids(rostik, ["world.manage"], false).includes("world.game-settings"), "only where the deployment keeps them");
  assert.equal(settingsAvailable(minecraft, vanilla), false, "a legacy world has no record to keep them in");
  assert.ok(!ids(vanilla, ["world.manage"]).includes("world.game-settings"));
});

test("the world's details say which settings differ from the game's defaults", () => {
  assert.deepEqual(changedSettings(minecraft, rostik), ["Difficulty: Hard", "Allow flight: On"]);
  const detail = worldDetails(minecraft, rostik, "running").find((item) => item.label === "Game settings");
  assert.deepEqual(detail?.value, { type: "text", text: "Difficulty: Hard, Allow flight: On" });
  const untouched = worldDetails(minecraft, { ...rostik, gameSettings: { values: {}, updatedAt: null } }, "running").find((item) => item.label === "Game settings");
  assert.deepEqual(untouched?.value, { type: "absent", text: "Game defaults" });
  assert.equal(worldDetails(minecraft, vanilla, "running").some((item) => item.label === "Game settings"), false);
});
