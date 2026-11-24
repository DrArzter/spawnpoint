import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorlds } from "./worlds-wiring.ts";
import { parameter } from "./http.ts";

export const worldsRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/presets/{presetId}/worlds": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.createWorld(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body)),
  "PUT /games/{gameId}/worlds/{worldId}/settings": permissionRoute("world.manage", (_identity, event) =>
    deployedWorlds.updateWorldSettings(parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) =>
    deployedWorlds.controlSession(identity, "start", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/stop": permissionRoute("session.stop", (identity, event) =>
    deployedWorlds.controlSession(identity, "stop", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (_identity, event) =>
    deployedWorlds.whitelistOf(parameter(event, "gameId"), parameter(event, "worldId"))),
  "PUT /games/{gameId}/worlds/{worldId}/whitelist": permissionRoute("whitelist.manage", (identity, event) =>
    deployedWorlds.updateWhitelist(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "PUT /games/{gameId}/worlds/{worldId}/game-settings": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.updateGameSettings(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/archive": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "archive", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/wipe": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "regenerate", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/restore": permissionRoute("backup.restore", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "restore", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/purge": permissionRoute("world.manage", (identity, event) =>
    deployedWorlds.controlWorldLifecycle(identity, "purge", parameter(event, "gameId"), parameter(event, "worldId"), event.body))
};
