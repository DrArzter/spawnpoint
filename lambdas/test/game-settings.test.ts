import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkGameSettings, gameSettingDefinitions } from "../src/control-plane/game-settings.ts";

// ADR-0064: a world sets game settings from one reviewed list per game. The
// list is the game module's own file, so the host exports exactly what the
// API accepted.

test("the API offers the settings the game module defines, and nothing the platform depends on", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../server/games/minecraft/settings.json", import.meta.url), "utf8")) as { settings: { id: string }[] };
  const definitions = gameSettingDefinitions("minecraft");
  assert.deepEqual(definitions.map((setting) => setting.id), onDisk.settings.map((setting) => setting.id));
  for (const reserved of ["online_mode", "level_name", "server_port", "rcon_password", "enable_whitelist", "memory"]) {
    assert.equal(definitions.some((setting) => setting.id === reserved), false, `${reserved} is the platform's`);
  }
  assert.deepEqual(gameSettingDefinitions("factorio"), [], "a game with no list has no settings");
});

test("each value is checked against its definition", () => {
  assert.deepEqual(checkGameSettings("minecraft", { difficulty: "hard", max_players: 8, pvp: false, motd: "Rostik's world: no griefing!" }), {
    ok: true, values: { difficulty: "hard", max_players: 8, pvp: false, motd: "Rostik's world: no griefing!" },
  });
  assert.deepEqual(checkGameSettings("minecraft", { max_players: 20 }), { ok: true, values: { max_players: 20 } }, "a default is kept once set, so the host keeps setting it");
  assert.deepEqual(checkGameSettings("minecraft", {}), { ok: true, values: {} });
  for (const [values, setting] of [
    [{ max_players: 500 }, "max_players"],
    [{ max_players: 2.5 }, "max_players"],
    [{ max_players: "8" }, "max_players"],
    [{ difficulty: "nightmare" }, "difficulty"],
    [{ pvp: "false" }, "pvp"],
    [{ motd: "" }, "motd"],
    [{ motd: "$(reboot)" }, "motd"],
    [{ motd: "two\nlines" }, "motd"],
    [{ motd: "x".repeat(60) }, "motd"],
  ] as const) {
    assert.deepEqual(checkGameSettings("minecraft", values), { ok: false, error: "invalid_game_setting", setting }, JSON.stringify(values));
  }
  assert.deepEqual(checkGameSettings("minecraft", { online_mode: true }), { ok: false, error: "unknown_game_setting", setting: "online_mode" });
  assert.deepEqual(checkGameSettings("minecraft", [1]), { ok: false, error: "invalid_game_settings" });
  assert.deepEqual(checkGameSettings("minecraft", undefined), { ok: false, error: "invalid_game_settings" });
  assert.deepEqual(checkGameSettings("factorio", {}), { ok: false, error: "game_has_no_settings" });
});
