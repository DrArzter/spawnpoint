import { type CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

import { METRIC_NAMESPACE, type MetricSink } from "./release-metrics.ts";

export function cloudWatchMetrics(client: Pick<CloudWatchClient, "send">): MetricSink {
  return {
    async put(metrics) {
      await client.send(new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metrics.map((metric) => ({ MetricName: metric.name, Value: metric.value, Unit: "Count" })),
      }));
    },
  };
}
