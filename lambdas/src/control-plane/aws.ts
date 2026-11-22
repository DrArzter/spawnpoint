import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataResult } from "@aws-sdk/client-cloudwatch";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";

import type { BackupObject } from "./backups.ts";
import type { BackupReleaseSources } from "./backup-release.ts";
import { s3BackupReleaseSources } from "./s3-backup-release.ts";
import { attachmentDisposition, packAttachmentName, releaseModKey, type ModStore, type ReleasePack } from "./release-artifacts.ts";
import { objectKey, releasePackStorageKey } from "./release-objects.ts";
import { dynamoReleaseStateReader } from "./dynamo-release-state.ts";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { presetBuildView, runningReleaseBuilds } from "./aws-release-builds.ts";
import { gameCatalog } from "./catalog.ts";
import { type ReleaseState } from "./release-state.ts";
import { ReleaseHolders, resolveFromWorldRecords } from "./release-holders.ts";
import { ReleaseRefs } from "./release-refs.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";
import { S3WorldReader, S3WorldRepository } from "./s3-world-repository.ts";
import { switchBeforeFirstStart, type SwitchOutcome, type SwitchRequest } from "./release-switch.ts";
import { newWorldRecord, withGameSettings, withWhitelist, withWorldAccess, type WorldGameSettings, type WorldRecord, type WorldWhitelist } from "./world-registry.ts";
import { parseDynamicProjection } from "./dynamic-projection.ts";
import { createSessionHostReader } from "./aws-session-history.ts";
import { createOperationProgressReader } from "./aws-operation-progress.ts";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildLifecycleStartInput, buildLifecycleStopInput, buildPromotionInput, buildStopInput } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostMetricPoint, HostMetrics, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";
import { operationWorldId } from "./world-session.ts";
import { expectationFromRuns, type FinishedRun } from "./operation-eta.ts";
import type { ConsoleInvocation } from "./console.ts";
import type { HostRecord, SessionPolicy } from "../domain/placement.ts";

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
      (type !== "start" && type !== "stop" && type !== "promote" && type !== "world") ||
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

// Holder first (ADR-0080): the stores below add a generation's holder before each write.
function releaseHolders(bucket: string): ReleaseHolders {
  return new ReleaseHolders(new ReleaseRefs(document), resolveFromWorldRecords(new S3WorldReader(s3, bucket)));
}

function worldRepository(): S3WorldRepository {
  const bucket = requiredEnv("RELEASE_BUCKET");
  return new S3WorldRepository(s3, bucket, releaseHolders(bucket));
}
const ssm = new SSMClient({});

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
const HOST_METRICS_NAMESPACE = "Spawnpoint/Host";
const HOST_SERIES = [
  { id: "cpu", label: "CPU", unit: "percent", namespace: "AWS/EC2", metric: "CPUUtilization", statistic: "Average" },
  { id: "memory", label: "Memory", unit: "percent", namespace: HOST_METRICS_NAMESPACE, metric: "MemoryUsedPercent", statistic: "Average" },
  { id: "networkIn", label: "Network in", unit: "bytes", namespace: "AWS/EC2", metric: "NetworkIn", statistic: "Sum" },
  { id: "networkOut", label: "Network out", unit: "bytes", namespace: "AWS/EC2", metric: "NetworkOut", statistic: "Sum" },
] as const;

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
): HostMetrics {
  const slots = metricSlots(window.start, window.end, window.period);
  return {
    startedAt: window.start.toISOString(),
    endedAt: window.end.toISOString(),
    periodSeconds: window.period,
    series: HOST_SERIES.map((series) => {
      const result = results.get(`${series.id}${suffix}`);
      return {
        id: series.id,
        label: series.label,
        unit: series.unit,
        points: onSlots(slots, window.period, result?.Timestamps ?? [], result?.Values ?? []),
      };
    }),
  };
}

async function readHostMetrics(instanceId: string, hours: number): Promise<HostMetrics> {
  return (await readHostsMetrics([instanceId], hours))[instanceId]!;
}

// A call takes up to 500 queries, so four series for each of up to 100 hosts
// fit; a world has far fewer sessions than that inside a week.
const MAX_METRIC_HOSTS = 100;

async function readHostsMetrics(instanceIds: readonly string[], hours: number): Promise<Readonly<Record<string, HostMetrics>>> {
  const hostIds = [...new Set(instanceIds)].slice(-MAX_METRIC_HOSTS);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const period = metricPeriodSeconds(hours);
  // One host keeps the plain series ids; several are told apart by position.
  const suffix = (index: number) => hostIds.length === 1 ? "" : `_${index}`;
  const response = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    ScanBy: "TimestampAscending",
    MetricDataQueries: hostIds.flatMap((hostId, index) => hostQueries(hostId, period, suffix(index))),
  }));
  const results = new Map((response.MetricDataResults ?? []).map((result) => [result.Id, result]));
  return Object.fromEntries(hostIds.map((hostId, index) => [hostId, hostMetricsFrom(results, suffix(index), { start, end, period })]));
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
  return type === "start" || type === "stop" || type === "promote" || type === "world";
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

async function listRunningOperations(): Promise<readonly OperationObservation[]> {
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
  readOperationProgress: createOperationProgressReader({ sfn, machines: operationMachines, expectation: expectedDuration }),
  readWorldSessionHosts: createSessionHostReader({ sfn, document, tableName: () => process.env.LIFECYCLE_TABLE_NAME, machines: operationMachines }),
  listWorldRecords,
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

function preconditionFailed(error: unknown): boolean {
  return error instanceof Error && (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

/** Moves a never-started wipe to another release (ADR-0078). Holders, pointer, record: see `switchBeforeFirstStart`. */
export async function switchReleaseBeforeFirstStart(request: SwitchRequest): Promise<SwitchOutcome> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const holders = releaseHolders(bucket);
  return switchBeforeFirstStart({
    holders,
    pointers: new S3ReleaseStateStore(s3, bucket, holders),
    worlds: new S3WorldRepository(s3, bucket, holders),
    now: () => new Date(),
  }, request);
}

export async function materializePresetWorld(
  preset: PresetObservation,
  identity: Readonly<{ worldId: string; displayName: string; release: string }>,
  generationUuid: string,
  createdAt: string,
  access?: Readonly<{ placement?: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"] }>,
): Promise<WorldRecord> {
  const proposed = newWorldRecord(preset, identity, generationUuid, createdAt, access);
  const releaseState: ReleaseState = {
    worldId: proposed.worldId,
    generationId: proposed.currentGeneration.id,
    desiredRelease: proposed.currentGeneration.release,
    activeRelease: null,
    updatedAt: createdAt,
    updatedBy: "world-creation",
    source: "create-world",
  };
  const bucket = requiredEnv("RELEASE_BUCKET");
  const holders = releaseHolders(bucket);
  const releaseStates = new S3ReleaseStateStore(s3, bucket, holders);
  const worlds = new S3WorldRepository(s3, bucket, holders);
  try {
    // The world record is not stored yet, so the pointer's holder takes the game and preset from the proposal.
    await releaseStates.create(releaseState, { gameId: proposed.gameId, presetId: proposed.preset.id });
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = await releaseStates.read({ worldId: proposed.worldId, generationId: proposed.currentGeneration.id });
    if (existing?.state.desiredRelease !== proposed.currentGeneration.release) {
      throw new Error("world_release_pointer_conflict");
    }
  }

  try {
    await worlds.create(proposed);
    return proposed;
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = (await worlds.read(proposed.worldId))?.record ?? null;
    if (
      existing?.worldId !== proposed.worldId || existing.gameId !== proposed.gameId ||
      existing.displayName !== proposed.displayName || existing.preset.id !== proposed.preset.id ||
      existing.preset.profileDigest !== proposed.preset.profileDigest ||
      existing.currentGeneration.release !== proposed.currentGeneration.release
    ) throw new Error("world_record_conflict");
    return existing;
  }
}

function machineArn(type: MachineType): string {
  const machine = operationMachines().find((candidate) => candidate.type === type);
  if (!machine) throw new Error(`missing ${type} state machine`);
  return machine.arn;
}

// The world id reaches a shell command on the host through the machines'
// States.Format, so its shape is checked here as well as by load_world there.
const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
function requireWorldId(worldId: string): string {
  if (!WORLD_ID.test(worldId)) throw new Error(`invalid world id: ${worldId}`);
  return worldId;
}

function configuredPlacement(): "single" | "shared" | "fleet" {
  const placement = process.env.SPAWNPOINT_PLACEMENT;
  return placement === "shared" || placement === "fleet" ? placement : "single";
}

export async function startSessionExecution(args: Readonly<{
  operationId: string;
  instanceId: string;
  requestedBy: string;
  /** The lifecycle record's key: the game's, or a fleet world's own (ADR-0062). */
  serverId: string;
  gameId: string;
  worldId: string;
  worldName: string;
  placement?: "single" | "shared" | "fleet";
  /** A fleet world's warm choice (ADR-0048); left out, the machine places it cold. */
  policy?: SessionPolicy;
}>): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, gameId, worldId, worldName, placement, policy } = args;
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildLifecycleStartInput({
      serverId, gameId, worldName, operationId, sessionId: `session-${randomUUID()}`, instanceId, worldId, requestedBy,
      placement: placement ?? configuredPlacement(),
      launch: process.env.SPAWNPOINT_LAUNCH === "enabled" ? "enabled" : "disabled",
      appCommit: process.env.SPAWNPOINT_APP_COMMIT || "main",
      ...(policy === undefined ? {} : { policy }),
    })),
  }));
  if (!started.executionArn) throw new Error("start execution did not return an ARN");
  return started.executionArn;
}

export async function stopSessionExecution(
  operationId: string,
  instanceId: string,
  requestedBy: string,
  serverId: string,
  sessionId: string,
  worldId: string,
): Promise<string> {
  requireWorldId(worldId);
  const stopped = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("stop"), name: operationId,
    input: JSON.stringify(buildLifecycleStopInput({ serverId, operationId, sessionId, instanceId, worldId, requestedBy })),
  }));
  if (!stopped.executionArn) throw new Error("stop execution did not return an ARN");
  return stopped.executionArn;
}

/** Starts the promote-release machine for a fleet world (ADR-0078); the execution is the operation record. */
export async function promotionExecution(args: Omit<Parameters<typeof buildPromotionInput>[0], "releaseBucket" | "launch" | "appCommit">): Promise<string> {
  requireWorldId(args.worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("promote"), name: args.operationId,
    input: JSON.stringify(buildPromotionInput({
      ...args,
      releaseBucket: requiredEnv("RELEASE_BUCKET"),
      launch: process.env.SPAWNPOINT_LAUNCH === "enabled" ? "enabled" : "disabled",
      appCommit: process.env.SPAWNPOINT_APP_COMMIT || "main",
    })),
  }));
  if (!started.executionArn) throw new Error("promotion execution did not return an ARN");
  return started.executionArn;
}

export async function worldLifecycleExecution(args: Readonly<{
  operationId: string;
  instanceId: string;
  requestedBy: string;
  serverId: string;
  sessionId: string;
  worldId: string;
  action: "archive" | "regenerate" | "restore" | "purge";
  backupKey: string | undefined;
  release: string | undefined;
  stopRequired: boolean;
  targetGenerationId: string;
}>): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, sessionId, worldId, action, backupKey, release, stopRequired, targetGenerationId } = args;
  requireWorldId(worldId);
  const stop = buildStopInput({ operationId, instanceId, requestedBy, worldId });
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("world"), name: operationId,
    input: JSON.stringify({
      serverId, operationId, sessionId, leaseTtlSeconds: 1800, instanceId, requestedBy, worldId, action, stopRequired, targetGenerationId,
      stopTiming: stop.timing,
      requestedAt: new Date().toISOString(),
      generationUuid: randomUUID(),
      backupKey: backupKey ?? "",
      release: release ?? "",
    }),
  }));
  if (!started.executionArn) throw new Error("world lifecycle execution did not return an ARN");
  return started.executionArn;
}

// The pack a player installs: the same object the bot serves, presigned for an
// hour. A missing object is a normal answer — releases published before packs
// were part of publication have none — so it is reported, not thrown.
export async function packDownloadUrl(gameId: string, presetId: string, release: string): Promise<string | null> {
  return releasePackUrl(gameId, presetId, release, "client", 3600);
}

/**
 * One pack of a release, by name, when it was published; named for the preset
 * and release it holds. An objects-v1 release keeps its packs as objects named
 * by digest, so the attachment name is what tells a player which pack it is.
 */
export async function releasePackUrl(gameId: string, presetId: string, release: string, pack: ReleasePack, expiresIn: number): Promise<string | null> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const key = releasePackStorageKey(await readReleaseManifest(gameId, presetId, release), gameId, presetId, release, pack);
  if (key === null) return null;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    return null;
  }
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: attachment(packAttachmentName(presetId, release, pack)),
  }), { expiresIn });
}

// A file the panel hands to someone, named as it is stored, so the browser
// saves it under that name whatever characters it holds.
const attachment = attachmentDisposition;

/**
 * One mod of a release, from either set, presigned for this role's read of
 * releases. A digest names the object of an objects-v1 release; without one the
 * mod is under its release's own keys.
 */
export function releaseModUrl(
  gameId: string,
  presetId: string,
  release: string,
  location: Readonly<{ file: string; store: ModStore }>,
  expiresIn: number,
  objectDigest?: string,
): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: requiredEnv("RELEASE_BUCKET"),
    Key: objectDigest === undefined ? releaseModKey(gameId, presetId, release, location.file, location.store) : objectKey(objectDigest),
    ResponseContentDisposition: attachment(location.file),
  }), { expiresIn });
}

/**
 * One world archive, presigned (ADR-0065). The caller has checked that the key
 * is this world's; a key with no object is a normal answer, not an error.
 */
export async function backupArchiveUrl(key: string, expiresIn: number): Promise<Readonly<{ url: string; sizeBytes: number }> | null> {
  const bucket = requiredEnv("BACKUP_BUCKET");
  let sizeBytes: number;
  try {
    sizeBytes = (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? 0;
  } catch (error) {
    if ((error as { name?: string }).name === "NotFound") return null;
    throw error;
  }
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: attachment(key.slice(key.lastIndexOf("/") + 1)),
  }), { expiresIn });
  return { url, sizeBytes };
}

// The inventory is a listing: the digest lives in the key and the listing
// reports each object's checksum algorithm, so listing never reads an archive.
// Reading one is a download, which only backup.download may ask for.
export async function listWorldBackups(worldId: string): Promise<readonly BackupObject[]> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: requiredEnv("BACKUP_BUCKET"),
    Prefix: `worlds/${worldId}/archives/`,
    MaxKeys: 200,
    OptionalObjectAttributes: undefined,
  }));
  return (response.Contents ?? []).flatMap((object) => object.Key && object.LastModified ? [{
    key: object.Key,
    sizeBytes: object.Size ?? 0,
    storedAt: object.LastModified.toISOString(),
    checksumAlgorithms: object.ChecksumAlgorithm ?? [],
  }] : []);
}

/** Each archive's recorded release and its wipe's pointer: one HEAD per archive, never a download. */
export function backupReleaseSources(): BackupReleaseSources {
  return s3BackupReleaseSources(s3, requiredEnv("BACKUP_BUCKET"), requiredEnv("RELEASE_BUCKET"));
}

export async function readWorldRecord(worldId: string): Promise<WorldRecord | null> {
  return (await new S3WorldReader(s3, requiredEnv("RELEASE_BUCKET")).read(worldId))?.record ?? null;
}

/** A world's game settings (ADR-0064); a running world takes them at its next start. */
export async function replaceWorldGameSettings(
  gameId: string,
  worldId: string,
  gameSettings: WorldGameSettings,
): Promise<"updated" | "missing" | "archived" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "archived";
  try {
    await worlds.replace(withGameSettings(stored.record, gameSettings), stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

/** A world's whitelist (ADR-0066). The world keeps it from now on, on every host it lands. */
export async function replaceWorldWhitelist(
  gameId: string,
  worldId: string,
  whitelist: WorldWhitelist,
): Promise<"updated" | "missing" | "archived" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "archived";
  try {
    await worlds.replace(withWhitelist(stored.record, whitelist), stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

export async function replaceWorldAccess(
  gameId: string,
  worldId: string,
  access: Readonly<{ placement: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"]; warm?: boolean }>,
): Promise<"updated" | "missing" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "conflict";
  const next = withWorldAccess(stored.record, access);
  if (next.placement === stored.record.placement && next.connectivity === stored.record.connectivity && next.auth === stored.record.auth && next.warm === stored.record.warm) return "updated";
  try {
    await worlds.replace(next, stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

// --- The console gateway (ADR-0063) -------------------------------------------

/** Which host and slot a session holds, from the host records beside the lifecycle. */
export async function findSessionPlacement(sessionId: string): Promise<Readonly<{ hostId: string; slot: number }> | null> {
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

export async function sendConsoleCommand(args: Readonly<{ hostId: string; worldId: string; slot: string; encodedCommand: string }>): Promise<string> {
  requireWorldId(args.worldId);
  const sent = await ssm.send(new SendCommandCommand({
    DocumentName: requiredEnv("CONSOLE_DOCUMENT_NAME"),
    InstanceIds: [args.hostId],
    Parameters: { worldId: [args.worldId], slot: [args.slot], command: [args.encodedCommand] },
    TimeoutSeconds: 60,
    Comment: `console ${args.worldId}`,
  }));
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("console command did not return an id");
  return commandId;
}

/**
 * Asks a running world's host to write the whitelist from the world's record
 * and reload it (ADR-0066). Only the world and the slot travel: the host reads
 * the names from S3 itself.
 */
export async function sendWhitelistReload(args: Readonly<{ hostId: string; worldId: string; slot: string }>): Promise<string> {
  requireWorldId(args.worldId);
  const sent = await ssm.send(new SendCommandCommand({
    DocumentName: requiredEnv("WHITELIST_DOCUMENT_NAME"),
    InstanceIds: [args.hostId],
    Parameters: { worldId: [args.worldId], slot: [args.slot] },
    TimeoutSeconds: 60,
    Comment: `whitelist ${args.worldId}`,
  }));
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("whitelist reload did not return an id");
  return commandId;
}

export async function readConsoleInvocation(commandId: string, hostId: string): Promise<ConsoleInvocation> {
  try {
    const invocation = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: hostId }));
    return {
      status: invocation.Status ?? "Pending",
      responseCode: invocation.ResponseCode ?? null,
      output: invocation.StandardOutputContent ?? "",
      error: invocation.StandardErrorContent ?? "",
    };
  } catch (error) {
    // A command just sent may not have reached the host's invocation list yet.
    if (error instanceof Error && error.name === "InvocationDoesNotExist") return { status: "Pending", responseCode: null, output: "", error: "" };
    throw error;
  }
}
