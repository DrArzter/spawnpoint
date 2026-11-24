import { permissionRoute, type Route } from "./routing.ts";
import { deployedWorldLog } from "./world-log-wiring.ts";
import { parameter } from "./http.ts";

// A world's recent log (ADR-0094), for whoever holds log.read. Addresses,
// ids and player names are replaced by tokens before any caller sees it.
export const worldLogRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/log": permissionRoute("log.read", (identity, event) =>
    deployedWorldLog.requestLog(identity, parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "read_world_log", title: "Read world log", effect: "read", mcp: true,
    description: "Ask a running world's host for the game's recent log, about its last 200 lines. Returns the read's id; read the lines with get_world_log_result. Addresses, ids and player names are replaced by tokens.",
  }),
  "GET /games/{gameId}/worlds/{worldId}/log/{readId}": permissionRoute("log.read", (_identity, event) =>
    deployedWorldLog.logResult(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "readId")), {
    name: "get_world_log_result", title: "Get world log result", effect: "read", mcp: true,
    description: "Read the lines of one log read by the id read_world_log returned. Its status stays pending until the host answers.",
  }),
};
