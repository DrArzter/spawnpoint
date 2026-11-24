import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorlds } from "./worlds-wiring.ts";
import { parameter } from "./http.ts";

const RELEASE = { type: "string", pattern: String.raw`^\d+\.\d+$`, description: "A release version of the world's preset, from get_control_plane" } as const;
const ACCESS = {
  placement: { type: "string", enum: ["configured", "fleet"], description: "Where the world runs: the deployment's configured host, or a host launched for it" },
  connectivity: { type: "string", enum: ["zerotier", "raw", "route53"], description: "How players reach it: the ZeroTier network, the host's public address, or a DNS name" },
  auth: { type: "string", enum: ["game", "external"], description: "Who checks a player: the game's own accounts, or an external whitelist; needed unless connectivity is zerotier" },
} as const;

export const worldsRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/presets/{presetId}/worlds": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.createWorld(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body), {
    name: "create_world", title: "Create world", effect: "write",
    description: "Create a world from a preset on one of its built releases. It starts stopped; start it with start_world.",
    input: { displayName: { type: "string", minLength: 1, maxLength: 80, description: "The world's name, as players see it" }, release: RELEASE, ...ACCESS },
    required: ["displayName", "release"],
  }),
  "PUT /games/{gameId}/worlds/{worldId}/settings": permissionRoute("world.manage", (_identity, event) =>
    deployedWorlds.updateWorldSettings(parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "update_world_settings", title: "Change world hosting", effect: "write",
    description: "Change where a stopped world runs and how players reach it. Refused while the world runs.",
    input: { ...ACCESS, warm: { type: "boolean", description: "Keep its launched host stopped, not destroyed, between sessions (fleet only)" } },
  }),
  "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) =>
    deployedWorlds.controlSession(identity, "start", parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "start_world", title: "Start world", effect: "write", mcp: true,
    description: "Request that Spawnpoint start one world. The returned operation is asynchronous; poll get_control_plane for completion.",
  }),
  "POST /games/{gameId}/worlds/{worldId}/stop": permissionRoute("session.stop", (identity, event) =>
    deployedWorlds.controlSession(identity, "stop", parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "stop_world", title: "Stop world", effect: "write", mcp: true,
    description: "Request a verified backup and stop for one world. The returned operation is asynchronous; poll get_control_plane for completion.",
    input: { players: { type: "string", enum: ["refuse", "disconnect"], description: "With players online: refuse to stop (the default), or disconnect them" } },
  }),
  "GET /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (_identity, event) =>
    deployedWorlds.whitelistOf(parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "get_whitelist", title: "Get whitelist", effect: "read",
    description: "Read the players who may join a world: the names its record keeps, or the running server's own list.",
  }),
  "PUT /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (identity, event) =>
    deployedWorlds.updateWhitelist(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "set_whitelist", title: "Set whitelist", effect: "write",
    description: "Replace a world's whitelist with this whole list of names. A running world reloads it at once.",
    input: { names: { type: "array", items: { type: "string" }, maxItems: 200, description: "Every player name that may join, as the players type them" } },
    required: ["names"],
  }),
  "PUT /games/{gameId}/worlds/{worldId}/game-settings": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.updateGameSettings(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "update_game_settings", title: "Change game settings", effect: "write",
    description: "Set a world's game settings, such as difficulty or the player limit, by the setting ids get_control_plane lists for its game. They apply at the next start.",
    input: { values: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Setting id to value; a setting left out keeps its default" } },
    required: ["values"],
  }),
  "POST /games/{gameId}/worlds/{worldId}/archive": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "archive", parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "archive_world", title: "Archive world", effect: "write",
    description: "Archive a stopped world: it keeps its backups and can be restored, but cannot start until then.",
  }),
  "POST /games/{gameId}/worlds/{worldId}/wipe": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "regenerate", parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "wipe_world", title: "Wipe world", effect: "write", destructive: true,
    description: "Start a new wipe of a world on a release: the current map is backed up and closed, and the next start makes a new one.",
    input: { release: RELEASE },
    required: ["release"],
  }),
  "POST /games/{gameId}/worlds/{worldId}/restore": permissionRoute("backup.restore", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "restore", parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "restore_backup", title: "Restore backup", effect: "write", destructive: true,
    description: "Restore one of a world's backups, which opens a new wipe from it. The current map is backed up first.",
    input: { backupKey: { type: "string", minLength: 1, description: "The archive's key from list_world_backups" } },
    required: ["backupKey"],
  }),
  "POST /games/{gameId}/worlds/{worldId}/purge": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "purge", parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "purge_world", title: "Delete world permanently", effect: "write", destructive: true,
    description: "Delete an archived world and every backup of it, permanently.",
    input: { confirmation: { type: "string", description: "The world's id again, to confirm" } },
    required: ["confirmation"],
  }),
};
