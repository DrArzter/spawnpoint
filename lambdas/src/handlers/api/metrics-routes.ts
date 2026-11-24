import { METRIC_RANGE_NAMES } from "../../control-plane/metric-ranges.ts";
import { permissionRoute, type Route } from "./routing.ts";
import { hostMetrics, worldMetrics } from "./metrics.ts";
import { parameter } from "./http.ts";

const RANGE = { type: "string", enum: [...METRIC_RANGE_NAMES], default: "24h", description: "How far back to read" } as const;

export const metricsRoutes: Readonly<Record<string, Route>> = {
  "GET /hosts/{instanceId}/metrics": permissionRoute("metrics.read", (_identity, event) =>
    hostMetrics(parameter(event, "instanceId"), event.queryStringParameters?.range ?? "24h"), {
    name: "get_host_metrics", title: "Get host metrics", effect: "read", mcp: true,
    description: "Read recent metrics for one host shown by get_control_plane. Name it by hostId.",
    // The host was first named by its instance id (review R43); both names are taken.
    pathNames: { instanceId: "hostId" },
    input: { range: RANGE },
  }),
  "GET /games/{gameId}/worlds/{worldId}/metrics": permissionRoute("metrics.read", (_identity, event) =>
    worldMetrics(parameter(event, "gameId"), parameter(event, "worldId"), event.queryStringParameters?.range ?? "24h"), {
    name: "get_world_metrics", title: "Get world metrics", effect: "read",
    description: "Read recent metrics for one world's session: players, tick time, memory and processor.",
    input: { range: RANGE },
  }),
};
