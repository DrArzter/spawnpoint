import { permissionRoute, type Route } from "./routing.ts";
import { operationProgress } from "./operations.ts";
import { parameter } from "./http.ts";

export const operationsRoutes: Readonly<Record<string, Route>> = {
  // The authority that reads a world's operations in GET /control-plane.
  "GET /games/{gameId}/worlds/{worldId}/operations/{operationId}": permissionRoute("status.read", (_identity, event) =>
    operationProgress(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "operationId")))
};
