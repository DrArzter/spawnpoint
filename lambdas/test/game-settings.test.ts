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

test("Valheim offers its server name, and never its password, world name, port, listing or crossplay", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../server/games/valheim/settings.json", import.meta.url), "utf8")) as { settings: { id: string; env: string }[] };
  const definitions = gameSettingDefinitions("valheim");
  assert.deepEqual(definitions.map((setting) => setting.id), onDisk.settings.map((setting) => setting.id));
  for (const reserved of ["SERVER_PASS", "WORLD_NAME", "SERVER_PORT", "SERVER_PUBLIC", "CROSSPLAY", "SERVER_ARGS"]) {
    assert.equal(onDisk.settings.some((setting) => setting.env === reserved), false, `${reserved} is the platform's`);
  }
  assert.deepEqual(checkGameSettings("valheim", { server_name: "Long ships" }), { ok: true, values: { server_name: "Long ships" } });
  assert.deepEqual(checkGameSettings("valheim", { server_name: "-crossplay $(id)" }), { ok: false, error: "invalid_game_setting", setting: "server_name" });
});

test("Palworld offers its name, player limit and death penalty, and never its passwords, ports, API or crossplay", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../server/games/palworld/settings.json", import.meta.url), "utf8")) as { settings: { id: string; env: string }[] };
  const definitions = gameSettingDefinitions("palworld");
  assert.deepEqual(definitions.map((setting) => setting.id), onDisk.settings.map((setting) => setting.id));
  for (const reserved of ["ADMIN_PASSWORD", "SERVER_PASSWORD", "PORT", "PUBLIC_PORT", "REST_API_ENABLED", "REST_API_PORT", "RCON_ENABLED", "COMMUNITY", "CROSSPLAY_PLATFORMS", "MOD_ENABLED"]) {
    assert.equal(onDisk.settings.some((setting) => setting.env === reserved), false, `${reserved} is the platform's`);
  }
  assert.deepEqual(checkGameSettings("palworld", { server_name: "Pal camp", max_players: 8, death_penalty: "None" }), {
    ok: true, values: { server_name: "Pal camp", max_players: 8, death_penalty: "None" },
  });
  assert.deepEqual(checkGameSettings("palworld", { server_name: "Pal \"camp\"" }), { ok: false, error: "invalid_game_setting", setting: "server_name" });
  assert.deepEqual(checkGameSettings("palworld", { max_players: 33 }), { ok: false, error: "invalid_game_setting", setting: "max_players" });
  assert.deepEqual(checkGameSettings("palworld", { death_penalty: "Everything" }), { ok: false, error: "invalid_game_setting", setting: "death_penalty" });
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
