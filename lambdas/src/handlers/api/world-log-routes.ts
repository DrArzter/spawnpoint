import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorldLog } from "./world-log-wiring.ts";
import { parameter } from "./http.ts";

// A world's recent log (ADR-0094), for whoever holds log.read.
export const worldLogRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/log": permissionRoute("log.read", (identity, event) =>
    deployedWorldLog.requestLog(identity, parameter(event, "gameId"), parameter(event, "worldId"))),
  "GET /games/{gameId}/worlds/{worldId}/log/{readId}": permissionRoute("log.read", (_identity, event) =>
    deployedWorldLog.logResult(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "readId"))),
};
