import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataResult } from "@aws-sdk/client-cloudwatch";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";

import { dynamoReleaseStateReader } from "./dynamo-release-state.ts";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { presetBuildView, runningReleaseBuilds } from "./aws-release-builds.ts";
import { gameCatalog } from "./catalog.ts";
import { type ReleaseState } from "./release-state.ts";
import { releaseHolders } from "./aws-world-records.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";
import { S3WorldReader, S3WorldRepository } from "./s3-world-repository.ts";
import { switchBeforeFirstStart, type SwitchOutcome, type SwitchRequest } from "./release-switch.ts";
import { newWorldRecord, withGameSettings, withWhitelist, withWorldAccess, type WorldGameSettings, type WorldRecord, type WorldWhitelist } from "./world-registry.ts";
import { parseDynamicProjection } from "./dynamic-projection.ts";
import { createSessionHostReader } from "./aws-session-history.ts";
import { createCommandLogReader, createOperationProgressReader, createHostLogReader } from "./aws-operation-progress.ts";
import { dynamoOperationRecordStore } from "./dynamo-operation-records.ts";
import { dynamoTable } from "./dynamo-table.ts";
import { runningOperations } from "./operation-record-progress.ts";
import { createHostShapeReader } from "./aws-host-shapes.ts";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildLifecycleStartInput, buildLifecycleStopInput, buildPromotionInput, buildStopInput, type StopPlayersPolicy } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostMetricPoint, HostMetricsWindow, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";
import { operationWorldId } from "./world-session.ts";
import { expectationFromRuns, type FinishedRun } from "./operation-eta.ts";
import type { HostRecord, HostShape, SessionPolicy } from "../domain/placement.ts";
import type { MetricUnit } from "../../../contract/metrics.ts";

type MachineType = OperationObservation["type"];
type OperationMachine = Readonly<{ type: MachineType; arn: string }>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

function operationMachines(): readonly OperationMachine[] {
  const value = JSON.parse(requiredEnv("OPERATION_STATE_MACHINES")) as unknown;
  if (!Array.isArray(value)) throw new Error("OPERATION_STATE_MACHINES must be an array");
  return value.map((item) => {
    if (item === null || typeof item !== "object") throw new Error("invalid operation state machine entry");
    const type = "type" in item ? item.type : undefined;
    const arn = "arn" in item ? item.arn : undefined;
    if (
      (type !== "start" && type !== "stop" && type !== "promote" && type !== "world" && type !== "host") ||
      typeof arn !== "string" ||
      !arn
    ) {
      throw new Error("invalid operation state machine entry");
    }
    return { type, arn };
  });
}

const ec2 = new EC2Client({});
const s3 = new S3Client({});
const cloudwatch = new CloudWatchClient({});
const sfn = new SFNClient({});
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const readReleaseState = dynamoReleaseStateReader(document);
const readHostShapes = createHostShapeReader(ec2);

const ssm = new SSMClient({});
const logs = new CloudWatchLogsClient({});

// The records the workflows write (ADR-0105); absent where the view table is not configured.
const operationRecordTable = process.env.CONTROL_PLANE_VIEW_TABLE;
const operationRecords = operationRecordTable ? dynamoOperationRecordStore(dynamoTable(document), operationRecordTable) : null;

function tag(instance: Instance, key: string): string | undefined {
  return instance.Tags?.find((candidate) => candidate.Key === key)?.Value;
}

function hostState(value: string | undefined): HostObservation["state"] {
  return value === "pending" || value === "running" || value === "stopping" || value === "stopped" ? value : "unknown";
}

async function listHosts(): Promise<readonly HostObservation[]> {
  const response = await ec2.send(new DescribeInstancesCommand({ Filters: [
    { Name: "tag:Project", Values: ["spawnpoint"] },
    { Name: "tag:Purpose", Values: ["minecraft-session-host", "game-host"] },
    { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
  ] }));
  return (response.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []).flatMap((instance) => {
    if (!instance.InstanceId) return [];
    const name = tag(instance, "Name") ?? instance.InstanceId;
    return [{
      id: name,
      name,
      state: hostState(instance.State?.Name),
      providerRef: instance.InstanceId,
      instanceType: instance.InstanceType ?? null,
      availabilityZone: instance.Placement?.AvailabilityZone ?? null,
      market: instance.InstanceLifecycle === "spot" ? "spot" as const : "on-demand" as const,
      launchedAt: instance.LaunchTime?.toISOString() ?? null,
      publicIp: instance.PublicIpAddress ?? null,
      provenance: tag(instance, "ManagedBy") === "spawnpoint-fleet" ? "launched" as const : "configured" as const,
    }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

async function readLifecycle(serverId: string): Promise<LifecycleRecord | null> {
  const response = await document.send(new GetCommand({
    TableName: requiredEnv("LIFECYCLE_TABLE_NAME"),
    Key: { server_id: serverId },
    ConsistentRead: true,
    ProjectionExpression: "lifecycle",
  }));
  return response.Item?.lifecycle as LifecycleRecord | undefined ?? null;
}

async function readReleasePointer(worldId: string, generationId: string | null): Promise<ReleasePointerObservation> {
  try {
    if (generationId === null) return { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null };
    const bucket = requiredEnv("RELEASE_BUCKET");
    const stored = await new S3ReleaseStateStore(s3, bucket, releaseHolders(bucket)).readOrMigrateLegacy({ worldId, generationId });
    if (stored === null) return { state: "unconfigured", generationId, desiredRelease: null, activeRelease: null };
    return {
      state: "available",
      generationId: stored.state.generationId,
      desiredRelease: stored.state.desiredRelease,
      activeRelease: stored.state.activeRelease,
      runCount: stored.state.releasesRun?.length ?? 0,
    };
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) {
      return { state: "unconfigured", generationId, desiredRelease: null, activeRelease: null };
    }
    console.error("release_pointer_read_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
    return { state: "unavailable", generationId, desiredRelease: null, activeRelease: null };
  }
}

async function listPresets(): Promise<readonly PresetObservation[]> {
  const running = runningReleaseBuilds().catch((error: unknown) => {
    console.error("release_builds_read_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    return null;
  });
  const groups = await Promise.all(gameCatalog.map(async (game) => {
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: requiredEnv("RELEASE_BUCKET"),
        Key: `presets/${game.id}/catalog.json`,
      }));
      const body = await response.Body?.transformToString();
      if (!body) return [];
      const catalog: unknown = JSON.parse(body);
      const parsed = parsePresetCatalog(catalog, game.id);
      if (parsed === null) throw new Error("invalid preset catalog");
      const active = await running;
      if (active === null) return parsed.map((preset) => ({ ...preset, buildAvailable: false }));
      return await Promise.all(parsed.map((preset) => presetBuildView(preset, catalog, active).catch((error: unknown) => {
        console.error("preset_build_read_failed", { gameId: game.id, presetId: preset.id, errorName: error instanceof Error ? error.name : "UnknownError" });
        return { ...preset, buildAvailable: false };
      })));
    } catch (error) {
      if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) return [];
      console.error("preset_catalog_read_failed", { gameId: game.id, errorName: error instanceof Error ? error.name : "UnknownError" });
      return [];
    }
  }));
  return groups.flat();
}

// The manifest is the only record of what a release contains. It is small, it
// is immutable once written, and it is read fresh: a cached answer here would
// be a claim about bytes somebody may be about to install.
async function readReleaseDocument(gameId: string, presetId: string, version: string, name: "manifest" | "plan"): Promise<unknown> {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: requiredEnv("RELEASE_BUCKET"),
      Key: `releases/${gameId}/${presetId}/${version}/${name}.json`,
    }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) return null;
    console.error(`release_${name}_read_failed`, { gameId, presetId, errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  }
}

async function readReleaseManifest(gameId: string, presetId: string, version: string): Promise<unknown> {
  return readReleaseDocument(gameId, presetId, version, "manifest");
}

// What the build that published a release changed (plan-release.sh). Older
// releases have none.
async function readReleasePlan(gameId: string, presetId: string, version: string): Promise<unknown> {
  return readReleaseDocument(gameId, presetId, version, "plan");
}

// Basic EC2 monitoring publishes the first group free at five-minute grain, which
// is the grain a reader of "was it busy last night" actually needs. EC2 has no
// memory metric, so the idle watchdog publishes one beside its player probe
// (ADR-0015). A series with no readings stays empty: an instance that was
// stopped, or a session whose host predates the probe, has none, and that
// absence is the most informative thing on the chart.
//
// CPU and memory stay a percentage of the whole host; each reading carries the
// host's size as its capacity, so the panel can show cores and bytes. Network is
// a rate: the period's sum over its seconds, so a week reads on the same scale
// as six hours.
const HOST_METRICS_NAMESPACE = "Spawnpoint/Host";
const MIB = 1024 * 1024;

type HostSeriesSpec = Readonly<{
  id: string;
  label: string;
  unit: MetricUnit;
  namespace: string;
  metric: string;
  statistic: "Average" | "Sum";
  capacity?: Readonly<{ unit: MetricUnit; of: (shape: HostShape) => number }>;
}>;

const HOST_SERIES: readonly HostSeriesSpec[] = [
  { id: "cpu", label: "CPU", unit: "percent", namespace: "AWS/EC2", metric: "CPUUtilization", statistic: "Average", capacity: { unit: "cores", of: (shape) => shape.vcpu } },
  { id: "memory", label: "Memory", unit: "percent", namespace: HOST_METRICS_NAMESPACE, metric: "MemoryUsedPercent", statistic: "Average", capacity: { unit: "bytes", of: (shape) => shape.memoryMiB * MIB } },
  { id: "networkIn", label: "Network in", unit: "bytesPerSecond", namespace: "AWS/EC2", metric: "NetworkIn", statistic: "Sum" },
  { id: "networkOut", label: "Network out", unit: "bytesPerSecond", namespace: "AWS/EC2", metric: "NetworkOut", statistic: "Sum" },
];

function metricPeriodSeconds(hours: number): number {
  if (hours <= 6) return 300;
  return hours <= 48 ? 900 : 3600;
}

function hostQueries(instanceId: string, period: number, suffix: string) {
  return HOST_SERIES.map((series) => ({
    Id: `${series.id}${suffix}`,
    MetricStat: {
      Metric: { Namespace: series.namespace, MetricName: series.metric, Dimensions: [{ Name: "InstanceId", Value: instanceId }] },
      Period: period,
      Stat: series.statistic,
    },
  }));
}

function hostMetricsFrom(
  results: ReadonlyMap<string | undefined, MetricDataResult>,
  suffix: string,
  window: Readonly<{ start: Date; end: Date; period: number }>,
  shape: HostShape | undefined,
): HostMetricsWindow {
  const slots = metricSlots(window.start, window.end, window.period);
  return {
    startedAt: window.start.toISOString(),
    endedAt: window.end.toISOString(),
    periodSeconds: window.period,
    series: HOST_SERIES.map((series) => {
      const result = results.get(`${series.id}${suffix}`);
      const values = series.statistic === "Sum" ? (result?.Values ?? []).map((value) => value / window.period) : result?.Values ?? [];
      const capacity = shape && series.capacity ? series.capacity.of(shape) : undefined;
      const points = onSlots(slots, window.period, result?.Timestamps ?? [], values);
      return {
        id: series.id,
        label: series.label,
        unit: series.unit,
        ...(series.capacity ? { capacityUnit: series.capacity.unit } : {}),
        points: capacity === undefined ? points : points.map((point) => point.value === null ? point : { ...point, capacity }),
      };
    }),
  };
}

async function readHostMetrics(instanceId: string, hours: number): Promise<HostMetricsWindow> {
  return (await readHostsMetrics([instanceId], hours))[instanceId]!;
}

// A call takes up to 500 queries, so four series for each of up to 100 hosts
// fit; a world has far fewer sessions than that inside a week.
const MAX_METRIC_HOSTS = 100;

async function readHostsMetrics(instanceIds: readonly string[], hours: number): Promise<Readonly<Record<string, HostMetricsWindow>>> {
  const hostIds = [...new Set(instanceIds)].slice(-MAX_METRIC_HOSTS);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const period = metricPeriodSeconds(hours);
  // One host keeps the plain series ids; several are told apart by position.
  const suffix = (index: number) => hostIds.length === 1 ? "" : `_${index}`;
  const [response, shapes] = await Promise.all([
    cloudwatch.send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      ScanBy: "TimestampAscending",
      MetricDataQueries: hostIds.flatMap((hostId, index) => hostQueries(hostId, period, suffix(index))),
    })),
    readHostShapes(hostIds),
  ]);
  const results = new Map((response.MetricDataResults ?? []).map((result) => [result.Id, result]));
  return Object.fromEntries(hostIds.map((hostId, index) => [hostId, hostMetricsFrom(results, suffix(index), { start, end, period }, shapes.get(hostId))]));
}

// CloudWatch returns only the periods that have data, so a host that was off
// leaves no datapoint at all. Every series is laid on the same grid of periods
// across the whole window, with null where nothing was reported.
function metricSlots(start: Date, end: Date, periodSeconds: number): number[] {
  const step = periodSeconds * 1000;
  const first = Math.floor(start.getTime() / step) * step;
  const slots: number[] = [];
  for (let at = first; at < end.getTime(); at += step) slots.push(at);
  return slots;
}

function onSlots(slots: readonly number[], periodSeconds: number, timestamps: readonly Date[], values: readonly number[]): HostMetricPoint[] {
  const step = periodSeconds * 1000;
  const first = slots[0] ?? 0;
  const byIndex = new Map<number, number>();
  timestamps.forEach((at, index) => {
    const value = values[index];
    if (value !== undefined) byIndex.set(Math.floor((at.getTime() - first) / step), value);
  });
  return slots.map((at, index) => ({ at: new Date(at).toISOString(), value: byIndex.get(index) ?? null }));
}

async function listWorldRecords(): Promise<readonly WorldRecord[]> {
  return new S3WorldReader(s3, requiredEnv("RELEASE_BUCKET")).list();
}

function isSessionOperation(type: MachineType): type is OperationObservation["type"] {
  return type === "start" || type === "stop" || type === "promote" || type === "world" || type === "host";
}

// An execution's input never changes, so its world is read once per ARN.
// Failed reads are not kept, so the next listing tries again.
const worldByExecution = new Map<string, string | null>();

// Every session workflow's input names its world. An operation whose world
// cannot be read is attributed to none, and so blocks every world, as any
// operation once did (ADR-0062).
async function executionWorldId(executionArn: string): Promise<string | null> {
  if (worldByExecution.has(executionArn)) return worldByExecution.get(executionArn)!;
  try {
    const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    const worldId = operationWorldId(described.input);
    worldByExecution.set(executionArn, worldId);
    return worldId;
  } catch (error) {
    console.warn("could not read the world of a running operation", executionArn, error);
    return null;
  }
}

// Every page: a running operation past the first page still blocks its world.
async function runningExecutions(stateMachineArn: string) {
  const running: Array<Readonly<{ name: string; startDate: Date; executionArn: string }>> = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn, statusFilter: "RUNNING", maxResults: 100, ...(nextToken ? { nextToken } : {}) })); // NOSONAR paginated: the next token comes from the previous page
    for (const execution of page.executions ?? []) {
      if (execution.name && execution.startDate && execution.executionArn) {
        running.push({ name: execution.name, startDate: execution.startDate, executionArn: execution.executionArn });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return running;
}

// How many finished runs to read per workflow, and how long they are kept. A
// panel polls, and an average over ten runs moves slowly.
const HISTORY_PAGE = 50;
const HISTORY_TTL_MS = 5 * 60 * 1000;

type MachineHistory = Readonly<{ readAt: number; runs: readonly FinishedRun[] }>;
const historyByMachine = new Map<string, MachineHistory>();

// The newest finished runs of one workflow, each with its world. Described
// worlds stay in `worldByExecution`, so a refresh describes only new runs.
// A failed read is kept as empty for the same time, so a throttled call is not
// repeated at every poll.
async function recentRuns(stateMachineArn: string, now: number): Promise<MachineHistory> {
  const cached = historyByMachine.get(stateMachineArn);
  if (cached && now - cached.readAt < HISTORY_TTL_MS) return cached;
  let runs: readonly FinishedRun[] = [];
  try {
    const page = await sfn.send(new ListExecutionsCommand({ stateMachineArn, statusFilter: "SUCCEEDED", maxResults: HISTORY_PAGE }));
    runs = await Promise.all((page.executions ?? [])
      .flatMap((execution) => execution.executionArn && execution.startDate && execution.stopDate
        ? [{ executionArn: execution.executionArn, startDate: execution.startDate, stopDate: execution.stopDate }]
        : [])
      .map(async ({ executionArn, startDate, stopDate }) => ({ executionArn, worldId: await executionWorldId(executionArn), startDate, stopDate })));
  } catch (error) {
    console.warn("could not read the finished runs of an operation workflow", stateMachineArn, error);
  }
  const history = { readAt: now, runs };
  historyByMachine.set(stateMachineArn, history);
  return history;
}

// A running operation's usual duration, from the finished runs the list reads.
async function expectedDuration(stateMachineArn: string, worldId: string) {
  return expectationFromRuns((await recentRuns(stateMachineArn, Date.now())).runs, worldId);
}

/** One run, read consistently: the operation when it still runs, or null. */
async function describeRunningOperation(executionArn: string): Promise<OperationObservation | null> {
  const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  const machine = operationMachines().find((candidate) => candidate.arn === described.stateMachineArn);
  if (described.status !== "RUNNING" || !machine || !isSessionOperation(machine.type) || !described.name || !described.startDate) return null;
  const worldId = operationWorldId(described.input);
  worldByExecution.set(executionArn, worldId);
  return {
    id: described.name,
    type: machine.type,
    status: "running",
    startedAt: described.startDate.toISOString(),
    providerRef: executionArn,
    worldId,
  };
}

/**
 * The operations that run now: the open records (ADR-0105), and a run the
 * executions list that has no record at all, which started before the records
 * did. Such a run is logged, once per listing; a run whose record exists is the
 * record's to tell, also when the record says it has ended.
 */
async function listRunningOperations(): Promise<readonly OperationObservation[]> {
  const records = operationRecords;
  if (records === null) return listRunningExecutions();
  const [open, executions] = await Promise.all([records.listOpen(), listRunningExecutions()]);
  const { recorded, unrecorded } = await runningOperations(open, executions, async (id) => await records.get(id) !== null);
  if (unrecorded.length > 0) console.info("operation_record_fallback", JSON.stringify({ reader: "list", operationIds: unrecorded.map((execution) => execution.id) }));
  const now = Date.now();
  const timed = await Promise.all(recorded.map((observation) => withExpectation(observation, now)));
  return [...timed, ...unrecorded].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// The usual duration still comes from the finished runs of the operation's machine.
async function withExpectation(observation: OperationObservation, now: number): Promise<OperationObservation> {
  const machine = operationMachines().find((candidate) => candidate.type === observation.type);
  if (machine === undefined || observation.worldId === null) return observation;
  const expected = expectationFromRuns((await recentRuns(machine.arn, now)).runs, observation.worldId);
  return { ...observation, ...expected };
}

async function listRunningExecutions(): Promise<readonly OperationObservation[]> {
  const machines = operationMachines().filter((machine) => isSessionOperation(machine.type));
  const now = Date.now();
  const groups = await Promise.all(machines.map(async (machine) => {
    const running = await runningExecutions(machine.arn);
    // Nothing running: the history is not read at all.
    const history = running.length > 0 ? await recentRuns(machine.arn, now) : null;
    return Promise.all(running.map(async (execution) => {
      const worldId = await executionWorldId(execution.executionArn);
      const expected = history && worldId !== null ? expectationFromRuns(history.runs, worldId) : null;
      return {
        id: execution.name,
        type: machine.type as OperationObservation["type"],
        status: "running" as const,
        startedAt: execution.startDate.toISOString(),
        providerRef: execution.executionArn,
        worldId,
        ...expected,
      };
    }));
  }));
  const operations = groups.flat();
  // Keep the cache to executions still running and the runs the histories hold.
  const keep = new Set(operations.map((operation) => operation.providerRef));
  for (const history of historyByMachine.values()) for (const run of history.runs) keep.add(run.executionArn);
  for (const executionArn of worldByExecution.keys()) if (!keep.has(executionArn)) worldByExecution.delete(executionArn);
  return operations.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** One listing page of the wipe's own archives is enough to know whether any exists. */
async function hasGenerationBackup(worldId: string, generationId: string): Promise<boolean> {
  const listing = await s3.send(new ListObjectsV2Command({
    Bucket: requiredEnv("BACKUP_BUCKET"),
    Prefix: `worlds/${worldId}/archives/${worldId}-${generationId}-`,
    MaxKeys: 1,
  }));
  return (listing.KeyCount ?? listing.Contents?.length ?? 0) > 0;
}

export { describeRunningOperation, operationMachines };

export const awsControlPlaneSources: ControlPlaneSources = {
  listHosts,
  readLifecycle,
  readReleasePointer,
  hasGenerationBackup,
  listRunningOperations,
  listPresets,
  readReleaseManifest,
  readReleaseState,
  readReleasePlan,
  readHostMetrics,
  readHostsMetrics,
  readOperationProgress: createOperationProgressReader({
    sfn,
    hostLog: createHostLogReader({ ssm, logs }),
    records: operationRecords,
    commandLog: createCommandLogReader({ logs }),
    machines: operationMachines,
    expectation: expectedDuration,
  }),
  readWorldSessionHosts: createSessionHostReader({ sfn, document, tableName: () => process.env.LIFECYCLE_TABLE_NAME, machines: operationMachines }),
  listWorldRecords,
  findSessionPlacement: (sessionId) => findSessionPlacement(sessionId),
};

async function readDynamicProjection() {
  const tableName = process.env.CONTROL_PLANE_VIEW_TABLE;
  if (!tableName) return null;
  try {
    const response = await document.send(new GetCommand({
      TableName: tableName,
      Key: { pk: "PROJECTION#CONTROL_PLANE", sk: "DYNAMIC" },
    }));
    return parseDynamicProjection(response.Item, Date.now());
  } catch (error) {
    console.error("control_plane_projection_read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

export function dashboardControlPlaneSources(): ControlPlaneSources {
  const projection = readDynamicProjection();
  return {
    ...awsControlPlaneSources,
    readObservedAt: async () => {
      const value = await projection;
      return value === null ? null : new Date(value.observedAtEpochMilliseconds);
    },
    listHosts: async () => (await projection)?.hosts ?? listHosts(),
    listRunningOperations: async () => (await projection)?.operations ?? listRunningOperations(),
  };
}

// --- Where a session runs (ADR-0054) ------------------------------------------

/** Which host and slot a session holds, from the host records beside the lifecycle. */
async function findSessionPlacement(sessionId: string): Promise<Readonly<{ hostId: string; slot: number }> | null> {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new ScanCommand({
      TableName: requiredEnv("LIFECYCLE_TABLE_NAME"),
      FilterExpression: "begins_with(server_id, :prefix)",
      ExpressionAttributeValues: { ":prefix": "host#" },
      ProjectionExpression: "host",
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }));
    for (const item of page.Items ?? []) {
      const host = item.host as HostRecord | undefined;
      const held = host?.reservations.find((reservation) => reservation.sessionId === sessionId);
      if (host && held) return { hostId: host.hostId, slot: held.slot };
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}
