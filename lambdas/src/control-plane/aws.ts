import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";

import type { BackupObject } from "./backups.ts";
import { clientPackKey } from "./release-artifacts.ts";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { gameCatalog } from "./catalog.ts";
import { type ReleaseState } from "./release-state.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";
import { S3WorldRepository } from "./s3-world-repository.ts";
import { newWorldRecord, type WorldRecord } from "./world-registry.ts";
import { parseDynamicProjection } from "./dynamic-projection.ts";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildLifecycleStartInput, buildLifecycleStopInput, buildStopInput } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostMetrics, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";

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

function tag(instance: Instance, key: string): string | undefined {
  return instance.Tags?.find((candidate) => candidate.Key === key)?.Value;
}

function hostState(value: string | undefined): HostObservation["state"] {
  return value === "pending" || value === "running" || value === "stopping" || value === "stopped" ? value : "unknown";
}

async function listHosts(): Promise<readonly HostObservation[]> {
  const response = await ec2.send(new DescribeInstancesCommand({ Filters: [
    { Name: "tag:Project", Values: ["spawnpoint"] },
    { Name: "tag:Purpose", Values: ["minecraft-session-host"] },
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
    const stored = await new S3ReleaseStateStore(s3, requiredEnv("RELEASE_BUCKET")).readOrMigrateLegacy({ worldId, generationId });
    if (stored === null) return { state: "unconfigured", generationId, desiredRelease: null, activeRelease: null };
    return {
      state: "available",
      generationId: stored.state.generationId,
      desiredRelease: stored.state.desiredRelease,
      activeRelease: stored.state.activeRelease,
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
  const groups = await Promise.all(gameCatalog.map(async (game) => {
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: requiredEnv("RELEASE_BUCKET"),
        Key: `presets/${game.id}/catalog.json`,
      }));
      const body = await response.Body?.transformToString();
      if (!body) return [];
      const parsed = parsePresetCatalog(JSON.parse(body), game.id);
      if (parsed === null) throw new Error("invalid preset catalog");
      return parsed;
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
async function readReleaseManifest(gameId: string, presetId: string, version: string): Promise<unknown | null> {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: requiredEnv("RELEASE_BUCKET"),
      Key: `releases/${gameId}/${presetId}/${version}/manifest.json`,
    }));
    const body = await response.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) return null;
    console.error("release_manifest_read_failed", { gameId, presetId, errorName: error instanceof Error ? error.name : "UnknownError" });
    throw error;
  }
}

// Basic EC2 monitoring publishes these free at five-minute grain, which is the
// grain a reader of "was it busy last night" actually needs. A gap is kept as a
// null rather than dropped: an instance that was stopped has no datapoints, and
// that absence is the most informative thing on the chart.
const HOST_SERIES = [
  { id: "cpu", label: "CPU", unit: "percent", metric: "CPUUtilization", statistic: "Average" },
  { id: "networkIn", label: "Network in", unit: "bytes", metric: "NetworkIn", statistic: "Sum" },
  { id: "networkOut", label: "Network out", unit: "bytes", metric: "NetworkOut", statistic: "Sum" },
] as const;

async function readHostMetrics(instanceId: string, hours: number): Promise<HostMetrics> {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const period = hours <= 6 ? 300 : hours <= 48 ? 900 : 3600;
  const response = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    ScanBy: "TimestampAscending",
    MetricDataQueries: HOST_SERIES.map((series) => ({
      Id: series.id,
      MetricStat: {
        Metric: { Namespace: "AWS/EC2", MetricName: series.metric, Dimensions: [{ Name: "InstanceId", Value: instanceId }] },
        Period: period,
        Stat: series.statistic,
      },
    })),
  }));
  const byId = new Map((response.MetricDataResults ?? []).map((result) => [result.Id, result]));
  return {
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    periodSeconds: period,
    series: HOST_SERIES.map((series) => {
      const result = byId.get(series.id);
      const timestamps = result?.Timestamps ?? [];
      const values = result?.Values ?? [];
      return {
        id: series.id,
        label: series.label,
        unit: series.unit,
        points: timestamps.map((at, index) => ({ at: at.toISOString(), value: values[index] ?? null })),
      };
    }),
  };
}

async function listWorldRecords(): Promise<readonly WorldRecord[]> {
  return new S3WorldRepository(s3, requiredEnv("RELEASE_BUCKET")).list();
}

function isSessionOperation(type: MachineType): type is OperationObservation["type"] {
  return type === "start" || type === "stop" || type === "promote" || type === "world";
}

async function listRunningOperations(): Promise<readonly OperationObservation[]> {
  const machines = operationMachines().filter((machine) => isSessionOperation(machine.type));
  const groups = await Promise.all(machines.map(async (machine) => {
    const response = await sfn.send(new ListExecutionsCommand({ stateMachineArn: machine.arn, statusFilter: "RUNNING", maxResults: 10 }));
    return (response.executions ?? []).flatMap((execution) => execution.name && execution.startDate && execution.executionArn ? [{
      id: execution.name,
      type: machine.type as OperationObservation["type"],
      status: "running" as const,
      startedAt: execution.startDate.toISOString(),
      providerRef: execution.executionArn,
    }] : []);
  }));
  return groups.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export const awsControlPlaneSources: ControlPlaneSources = {
  listHosts,
  readLifecycle,
  readReleasePointer,
  listRunningOperations,
  listPresets,
  readReleaseManifest,
  readHostMetrics,
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

export async function materializePresetWorld(
  preset: PresetObservation,
  identity: Readonly<{ worldId: string; displayName: string; release: string }>,
  generationUuid: string,
  createdAt: string,
): Promise<WorldRecord> {
  const proposed = newWorldRecord(preset, identity, generationUuid, createdAt);
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
  const releaseStates = new S3ReleaseStateStore(s3, bucket);
  const worlds = new S3WorldRepository(s3, bucket);
  try {
    await releaseStates.create(releaseState);
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = await releaseStates.read({ worldId: proposed.worldId, generationId: proposed.currentGeneration.id });
    if (existing === null || existing.state.desiredRelease !== proposed.currentGeneration.release) {
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
      existing === null || existing.worldId !== proposed.worldId || existing.gameId !== proposed.gameId ||
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

export async function startSessionExecution(
  operationId: string,
  instanceId: string,
  requestedBy: string,
  serverId: string,
  worldId: string,
): Promise<string> {
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildLifecycleStartInput({
      serverId, operationId, sessionId: `session-${randomUUID()}`, instanceId, worldId, requestedBy,
      placement: process.env.SPAWNPOINT_PLACEMENT === "shared" ? "shared" : "single",
      launch: process.env.SPAWNPOINT_LAUNCH === "enabled" ? "enabled" : "disabled",
      appCommit: process.env.SPAWNPOINT_APP_COMMIT || "main",
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

export async function worldLifecycleExecution(
  operationId: string,
  instanceId: string,
  requestedBy: string,
  serverId: string,
  sessionId: string,
  worldId: string,
  action: "archive" | "regenerate" | "restore" | "purge",
  backupKey: string | undefined,
  release: string | undefined,
  stopRequired: boolean,
  targetGenerationId: string,
): Promise<string> {
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
  const bucket = requiredEnv("RELEASE_BUCKET");
  const key = clientPackKey(gameId, presetId, release);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    return null;
  }
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
}

// Deliberately ListObjectsV2 and nothing else: the digest lives in the key and
// the listing reports each object's checksum algorithm, so the panel can show
// an inventory without this role ever being able to read a world archive.
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
