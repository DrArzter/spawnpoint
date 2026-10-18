import { permissionRoute, type Route } from "./routing.ts";
import { runConsoleCommand, consoleHistory } from "./console.ts";
import { parameter } from "./http.ts";

export const consoleRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/console": permissionRoute("console.use", (identity, event) =>
    runConsoleCommand(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/console": permissionRoute("console.use", (_identity, event) =>
    consoleHistory(parameter(event, "gameId"), parameter(event, "worldId")))
};
