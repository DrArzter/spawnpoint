import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { RELEASE_REFS_TABLE_DEFAULT } from "../control-plane/release-objects.ts";
import { DIFF_CLASSES, compare, mark, type ConsistencyReport } from "../control-plane/release-reconciler.ts";
import {
  collectSources, dynamoRefsTableReader, s3BackupBucketReader, s3ReleaseBucketReader, type SourcePorts,
} from "../control-plane/s3-release-marks.ts";

// ADR-0080's reconciler, report-only: it reads the sources, the table and the
// object listing, logs what differs and puts metrics. No port here can write.
// A later mode (sweep, behind a dry-run flag) consumes the report this returns.

export const METRIC_NAMESPACE = "Spawnpoint/ReleaseReconciler";

export type Metric = Readonly<{ name: string; value: number }>;
export type MetricSink = Readonly<{ put(metrics: readonly Metric[]): Promise<void> }>;

export type ReconcilerDeps = Readonly<{ ports: SourcePorts; metrics: MetricSink; now(): Date }>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** An empty event is the weekly schedule. A later branch adds a mode here; any other string is refused. */
function checkMode(event: unknown): void {
  const mode = (event as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== undefined && mode !== "report") throw new Error("unsupported_mode");
}

export function reportMetrics(report: ConsistencyReport): readonly Metric[] {
  const count = (name: (typeof DIFF_CLASSES)[number]) => report.classes[name].count;
  return [
    { name: "DangerousDiff", value: report.dangerous },
    { name: "MissingObject", value: count("missing_object") },
    { name: "RunFailed", value: 0 },
    { name: "OrphanObjects", value: count("orphan_object") },
    { name: "ExtraReferences", value: count("extra_reference") },
    { name: "CounterDrift", value: count("counter_drift") },
    { name: "UnregisteredReleases", value: count("unregistered_release") },
    { name: "Incomplete", value: report.complete ? 0 : 1 },
  ];
}

export async function reconcile(event: unknown, deps: ReconcilerDeps): Promise<ConsistencyReport> {
  checkMode(event);
  try {
    const { input, table, listing } = await collectSources(deps.ports);
    const report = compare(mark(input), table, listing, deps.now().toISOString());
    for (const name of DIFF_CLASSES) {
      console.info(JSON.stringify({ event: "release_reconciler_class", class: name, ...report.classes[name] }));
    }
    console.info(JSON.stringify({
      event: "release_reconciler_summary", generatedAt: report.generatedAt, complete: report.complete, sweepable: report.sweepable,
      table_empty: report.table_empty, dangerous: report.dangerous, skipped: report.skipped, failures: report.failures,
    }));
    await deps.metrics.put(reportMetrics(report));
    return report;
  } catch (error) {
    console.error("release_reconciler_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    // The alarm must still fire when the metric put itself failed, so the original error wins.
    await deps.metrics.put([{ name: "RunFailed", value: 1 }]).catch(() => undefined);
    throw error;
  }
}

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

export async function handler(event: unknown = {}): Promise<ConsistencyReport> {
  const s3 = new S3Client({});
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  const backupBucket = requiredEnv("BACKUP_BUCKET");
  const table = process.env.RELEASE_REFS_TABLE ?? RELEASE_REFS_TABLE_DEFAULT;
  return reconcile(event, {
    ports: {
      release: s3ReleaseBucketReader(s3, releaseBucket),
      backup: s3BackupBucketReader(s3, backupBucket),
      table: dynamoRefsTableReader(DynamoDBDocumentClient.from(new DynamoDBClient({})), table),
    },
    metrics: cloudWatchMetrics(new CloudWatchClient({})),
    now: () => new Date(),
  });
}
