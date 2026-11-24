// The release reconciler's metrics port: counts per run, under one namespace.

export const METRIC_NAMESPACE = "Spawnpoint/ReleaseReconciler";

export type Metric = Readonly<{ name: string; value: number }>;
export type MetricSink = Readonly<{ put(metrics: readonly Metric[]): Promise<void> }>;
