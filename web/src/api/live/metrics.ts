import type { HostMetrics, MetricRange, SpawnpointApi } from "../contract";
import { requestOrNull } from "./request";
import { t } from "../../i18n";

export const metricsApi = {
  // A world that is not running has no metrics: 409, not a failure.
  loadWorldMetrics(gameId: string, worldId: string, range: MetricRange): Promise<HostMetrics | null> {
    return requestOrNull<HostMetrics>(
      `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/metrics?range=${range}`,
      { failure: t("metrics.hostMetricsCouldNot"), refusals: { forbidden: t("metrics.roleCannotReadMetrics") } },
      (error) => error.status === 409,
    );
  },
} satisfies Partial<SpawnpointApi>;
