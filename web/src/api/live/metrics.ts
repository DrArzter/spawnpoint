import { apiFailure, type HostMetrics, type MetricRange, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

export const metricsApi = {
  async loadHostMetrics(instanceId: string, range: MetricRange): Promise<HostMetrics> {
    const response = await authorizedFetch(`/hosts/${encodeURIComponent(instanceId)}/metrics?range=${range}`);
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot read metrics." : "Host metrics could not be loaded.");
    return await response.json() as HostMetrics;
  },
} satisfies Partial<SpawnpointApi>;
