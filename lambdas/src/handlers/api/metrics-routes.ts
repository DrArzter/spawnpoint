import { permissionRoute, type Route } from "./routing.ts";
import { hostMetrics, worldMetrics } from "./metrics.ts";
import { parameter } from "./http.ts";

export const metricsRoutes: Readonly<Record<string, Route>> = {
  "GET /hosts/{instanceId}/metrics": permissionRoute("metrics.read", (_identity, event) =>
    hostMetrics(parameter(event, "instanceId"), event.queryStringParameters?.range ?? "24h")),
  "GET /games/{gameId}/worlds/{worldId}/metrics": permissionRoute("metrics.read", (_identity, event) =>
    worldMetrics(parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.range ?? "24h"))
};
