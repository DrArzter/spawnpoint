import type { HostMetrics, MetricRange, SpawnpointApi } from "../contract";
import { requestOrNull } from "./request";

export const metricsApi = {
  // A world that is not running has no metrics: 409, not a failure.
  loadWorldMetrics(gameId: string, worldId: string, range: MetricRange): Promise<HostMetrics | null> {
    return requestOrNull<HostMetrics>(
      `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/metrics?range=${range}`,
      { failure: "Host metrics could not be loaded.", refusals: { forbidden: "Your role cannot read metrics." } },
      (error) => error.status === 409,
    );
  },
} satisfies Partial<SpawnpointApi>;
