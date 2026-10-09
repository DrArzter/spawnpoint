import { apiFailure, type HostMetrics, type MetricRange, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

export const metricsApi = {
  async loadWorldMetrics(gameId: string, worldId: string, range: MetricRange): Promise<HostMetrics | null> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/metrics?range=${range}`);
    if (response.status === 409) return null;
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot read metrics." : "Host metrics could not be loaded.");
    return await response.json() as HostMetrics;
  },
} satisfies Partial<SpawnpointApi>;
