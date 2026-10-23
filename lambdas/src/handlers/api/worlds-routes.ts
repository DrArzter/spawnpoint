import { permissionRoute, type Route } from "./routing.ts";
import { createWorld, updateWorldSettings, controlSession, whitelistOf, updateWhitelist, updateGameSettings, controlWorldLifecycle } from "./worlds.ts";
import { parameter } from "./http.ts";

export const worldsRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/presets/{presetId}/worlds": permissionRoute("world.manage", (identity, event) =>
    createWorld(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body)),
  "PUT /games/{gameId}/worlds/{worldId}/settings": permissionRoute("world.manage", (_identity, event) =>
    updateWorldSettings(parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) =>
    controlSession(identity, "start", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/stop": permissionRoute("session.stop", (identity, event) =>
    controlSession(identity, "stop", parameter(event, "gameId"), parameter(event, "worldId"))),
  "GET /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (_identity, event) =>
    whitelistOf(parameter(event, "gameId"), parameter(event, "worldId"))),
  "PUT /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (identity, event) =>
    updateWhitelist(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "PUT /games/{gameId}/worlds/{worldId}/game-settings": permissionRoute("world.manage", (identity, event) =>
    updateGameSettings(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/archive": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "archive", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/wipe": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "regenerate", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/restore": permissionRoute("backup.restore", (identity, event) =>
    controlWorldLifecycle(identity, "restore", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/purge": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "purge", parameter(event, "gameId"), parameter(event, "worldId"), event.body))
};
