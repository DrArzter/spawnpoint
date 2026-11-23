import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { RELEASE_REFS_TABLE_DEFAULT } from "../control-plane/release-objects.ts";
import { DIFF_CLASSES, compare, mark, type ConsistencyReport } from "../control-plane/release-reconciler.ts";
import {
  collectSources, dynamoRefsTableReader, s3BackupBucketReader, s3ReleaseBucketReader, type SourcePorts,
} from "../control-plane/s3-release-marks.ts";
import {
  describeSweep, executeSweep, planSweep, sweepCandidates, sweepDryRun, sweepGraceDays, SWEEP_GRACE_DAYS_DEFAULT, type SweepOutcome, type SweepPlan, type SweepWriter,
} from "../control-plane/release-sweep.ts";
import { createSweepWriter } from "../control-plane/s3-release-sweep.ts";

// ADR-0080's reconciler. It reads the sources, the table and the object
// listing, logs what differs and puts metrics. It then plans the sweep. Only a
// real run (RELEASE_SWEEP_DRY_RUN exactly "false") may write, and only through
// the writer that `sweep.writer` builds; the read ports below cannot write.

export const METRIC_NAMESPACE = "Spawnpoint/ReleaseReconciler";

export type Metric = Readonly<{ name: string; value: number }>;
export type MetricSink = Readonly<{ put(metrics: readonly Metric[]): Promise<void> }>;

export type SweepConfig = Readonly<{
  dryRun: boolean;
  graceDays: number;
  /** Called only when `dryRun` is false: a dry run builds no client that can write. */
  writer: () => SweepWriter;
}>;

export type ReconcilerDeps = Readonly<{ ports: SourcePorts; metrics: MetricSink; now(): Date; sweep: SweepConfig }>;

export type SweepSummary = Readonly<{
  dryRun: boolean;
  graceDays: number;
  reason: SweepPlan["reason"];
  candidates: number;
  swept: number;
  failed: number;
  orphansCondemned: number;
}>;

export type ReconcileResult = ConsistencyReport & Readonly<{ sweep: SweepSummary }>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** An empty event is the weekly schedule: the report, then the sweep as the flag allows. Any other mode string is refused. */
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

export function sweepMetrics(summary: SweepSummary): readonly Metric[] {
  return [
    { name: "SweepCandidates", value: summary.candidates },
    { name: "SweptObjects", value: summary.swept },
    { name: "SweepFailed", value: summary.failed },
    { name: "OrphansCondemned", value: summary.orphansCondemned },
    { name: "SweepDryRun", value: summary.dryRun ? 1 : 0 },
  ];
}

const NOTHING: SweepOutcome = { swept: 0, condemned: 0, reverted: 0, skipped: 0, failures: [] };

function logLine(line: Readonly<Record<string, unknown>>): void {
  console.info(JSON.stringify(line));
}

export async function reconcile(event: unknown, deps: ReconcilerDeps): Promise<ReconcileResult> {
  checkMode(event);
  try {
    // Taken before the first read: a delete needs a mark from a run that started after `condemned_at`.
    const startedAt = deps.now().toISOString();
    const { input, table, listing } = await collectSources(deps.ports, startedAt);
    const marks = mark(input);
    const report = compare(marks, table, listing, deps.now().toISOString(), startedAt);
    for (const name of DIFF_CLASSES) {
      console.info(JSON.stringify({ event: "release_reconciler_class", class: name, ...report.classes[name] }));
    }
    console.info(JSON.stringify({
      event: "release_reconciler_summary", generatedAt: report.generatedAt, startedAt, complete: report.complete, sweepable: report.sweepable,
      table_empty: report.table_empty, dangerous: report.dangerous, skipped: report.skipped, failures: report.failures,
    }));

    const { dryRun, graceDays } = deps.sweep;
    const plan = planSweep({ report, marks, table, listing, graceDays });
    let outcome = NOTHING;
    if (dryRun) {
      for (const line of describeSweep(plan)) logLine(line);
    } else if (plan.actions.length > 0) {
      outcome = await executeSweep(plan, deps.sweep.writer(), deps.now, logLine);
    }
    const sweep: SweepSummary = {
      dryRun, graceDays, reason: plan.reason, candidates: sweepCandidates(plan),
      swept: outcome.swept, failed: outcome.failures.length, orphansCondemned: outcome.condemned,
    };
    logLine({ event: "release_sweep_summary", ...sweep, cutoff: plan.cutoff, reverted: outcome.reverted, skipped: outcome.skipped, failures: outcome.failures.slice(0, 50) });
    await deps.metrics.put([...reportMetrics(report), ...sweepMetrics(sweep)]);
    return { ...report, sweep };
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

export async function handler(event: unknown = {}): Promise<ReconcileResult> {
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
    sweep: {
      dryRun: sweepDryRun(process.env.RELEASE_SWEEP_DRY_RUN),
      graceDays: sweepGraceDays(process.env.RELEASE_SWEEP_GRACE_DAYS ?? String(SWEEP_GRACE_DAYS_DEFAULT)),
      writer: () => createSweepWriter(releaseBucket, table),
    },
  });
}
