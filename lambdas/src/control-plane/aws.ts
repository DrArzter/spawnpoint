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
import { GetCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { randomUUID } from "node:crypto";

import type { BackupObject } from "./backups.ts";
import { clientPackKey, releaseModKey } from "./release-artifacts.ts";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { gameCatalog } from "./catalog.ts";
import { type ReleaseState } from "./release-state.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";
import { S3WorldRepository } from "./s3-world-repository.ts";
import { newWorldRecord, withGameSettings, withWhitelist, withWorldAccess, type WorldGameSettings, type WorldRecord, type WorldWhitelist } from "./world-registry.ts";
import { parseDynamicProjection } from "./dynamic-projection.ts";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildLifecycleStartInput, buildLifecycleStopInput, buildStopInput } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostMetrics, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";
import { operationWorldId } from "./world-session.ts";
import type { ConsoleInvocation } from "./console.ts";
import type { HostRecord } from "../domain/placement.ts";

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

// Every session workflow's input names its world. An operation whose world
// cannot be read is attributed to none, and so blocks every world, as any
// operation once did (ADR-0062).
async function executionWorldId(executionArn: string): Promise<string | null> {
  try {
    const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return operationWorldId(described.input);
  } catch (error) {
    console.warn("could not read the world of a running operation", executionArn, error);
    return null;
  }
}

async function listRunningOperations(): Promise<readonly OperationObservation[]> {
  const machines = operationMachines().filter((machine) => isSessionOperation(machine.type));
  const groups = await Promise.all(machines.map(async (machine) => {
    const response = await sfn.send(new ListExecutionsCommand({ stateMachineArn: machine.arn, statusFilter: "RUNNING", maxResults: 10 }));
    const running = (response.executions ?? []).flatMap((execution) => execution.name && execution.startDate && execution.executionArn
      ? [{ name: execution.name, startDate: execution.startDate, executionArn: execution.executionArn }]
      : []);
    return Promise.all(running.map(async (execution) => ({
      id: execution.name,
      type: machine.type as OperationObservation["type"],
      status: "running" as const,
      startedAt: execution.startDate.toISOString(),
      providerRef: execution.executionArn,
      worldId: await executionWorldId(execution.executionArn),
    })));
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
}>): Promise<string> {
  const { operationId, instanceId, requestedBy, serverId, gameId, worldId, worldName, placement } = args;
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildLifecycleStartInput({
      serverId, gameId, worldName, operationId, sessionId: `session-${randomUUID()}`, instanceId, worldId, requestedBy,
      placement: placement ?? configuredPlacement(),
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

// A file the panel hands to someone, named as it is stored, so the browser
// saves it under that name whatever characters it holds.
function attachment(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** One server mod of a release, presigned for this role's read of releases. */
export async function releaseModUrl(gameId: string, presetId: string, release: string, file: string, expiresIn: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: requiredEnv("RELEASE_BUCKET"),
    Key: releaseModKey(gameId, presetId, release, file),
    ResponseContentDisposition: attachment(file),
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

export async function readWorldRecord(worldId: string): Promise<WorldRecord | null> {
  return (await new S3WorldRepository(s3, requiredEnv("RELEASE_BUCKET")).read(worldId))?.record ?? null;
}

/** A world's game settings (ADR-0064); a running world takes them at its next start. */
export async function replaceWorldGameSettings(
  gameId: string,
  worldId: string,
  gameSettings: WorldGameSettings,
): Promise<"updated" | "missing" | "archived" | "conflict"> {
  const worlds = new S3WorldRepository(s3, requiredEnv("RELEASE_BUCKET"));
  const stored = await worlds.read(worldId);
  if (!stored || stored.record.gameId !== gameId) return "missing";
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
  const worlds = new S3WorldRepository(s3, requiredEnv("RELEASE_BUCKET"));
  const stored = await worlds.read(worldId);
  if (!stored || stored.record.gameId !== gameId) return "missing";
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
  access: Readonly<{ placement: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"] }>,
): Promise<"updated" | "missing" | "conflict"> {
  const worlds = new S3WorldRepository(s3, requiredEnv("RELEASE_BUCKET"));
  const stored = await worlds.read(worldId);
  if (!stored || stored.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "conflict";
  const next = withWorldAccess(stored.record, access);
  if (next.placement === stored.record.placement && next.connectivity === stored.record.connectivity && next.auth === stored.record.auth) return "updated";
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
