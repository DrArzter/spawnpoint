import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorldConfig } from "./world-config-wiring.ts";
import { parameter } from "./http.ts";

// A world's own config files (ADR-0093), for whoever holds config.edit.
export const worldConfigRoutes: Readonly<Record<string, Route>> = {
  "GET /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (_identity, event) =>
    deployedWorldConfig.listConfigFiles(parameter(event, "gameId"), parameter(event, "worldId"))),
  "GET /games/{gameId}/worlds/{worldId}/config-files/content": permissionRoute("config.edit", (_identity, event) =>
    deployedWorldConfig.readConfigFile(parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.path)),
  "PUT /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (identity, event) =>
    deployedWorldConfig.saveConfigFile(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "DELETE /games/{gameId}/worlds/{worldId}/config-files": permissionRoute("config.edit", (identity, event) =>
    deployedWorldConfig.resetConfigFile(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.path, event.queryStringParameters?.expected)),
};
