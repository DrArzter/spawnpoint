import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
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

import type { BackupObject } from "./backups.ts";
import { parsePresetCatalog, type PresetObservation } from "./preset-catalog.ts";
import { gameCatalog } from "./catalog.ts";
import { newWorldRecord, parseWorldRecord, worldRecordDocument, type WorldRecord } from "./world-registry.ts";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildStartInput, buildStopInput, buildWatchdogInput } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";

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
      (type !== "start" && type !== "stop" && type !== "promote") ||
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

async function readReleasePointer(worldId: string): Promise<ReleasePointerObservation> {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: requiredEnv("RELEASE_BUCKET"),
      Key: `worlds/${worldId}/release.json`,
    }));
    const body = await response.Body?.transformToString();
    if (!body) return { state: "unavailable", desiredRelease: null, activeRelease: null };
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      state: "available",
      desiredRelease: typeof parsed.desired_release === "string" ? parsed.desired_release : null,
      activeRelease: typeof parsed.active_release === "string" ? parsed.active_release : null,
    };
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) {
      return { state: "unconfigured", desiredRelease: null, activeRelease: null };
    }
    console.error("release_pointer_read_failed", { worldId, errorName: error instanceof Error ? error.name : "UnknownError" });
    return { state: "unavailable", desiredRelease: null, activeRelease: null };
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

async function listWorldRecords(): Promise<readonly WorldRecord[]> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "worlds/", MaxKeys: 500 }));
  const keys = (listing.Contents ?? []).flatMap((object) =>
    object.Key && /^worlds\/[a-z0-9][a-z0-9-]{0,31}\/world\.json$/.test(object.Key) ? [object.Key] : []);
  const records = await Promise.all(keys.map(async (key) => {
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await response.Body?.transformToString();
      const record = body ? parseWorldRecord(JSON.parse(body)) : null;
      if (record === null || key !== `worlds/${record.worldId}/world.json`) throw new Error("invalid world record");
      return record;
    } catch (error) {
      console.error("world_record_read_failed", { key, errorName: error instanceof Error ? error.name : "UnknownError" });
      return null;
    }
  }));
  return records.filter((record): record is WorldRecord => record !== null);
}

function isSessionOperation(type: MachineType): type is OperationObservation["type"] {
  return type === "start" || type === "stop" || type === "promote";
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
  listWorldRecords,
};

function preconditionFailed(error: unknown): boolean {
  return error instanceof Error && (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

async function readJsonObject(key: string): Promise<Record<string, unknown>> {
  const response = await s3.send(new GetObjectCommand({ Bucket: requiredEnv("RELEASE_BUCKET"), Key: key }));
  const body = await response.Body?.transformToString();
  if (!body) throw new Error(`empty object: ${key}`);
  const parsed = JSON.parse(body) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid object: ${key}`);
  return parsed as Record<string, unknown>;
}

async function createJsonObject(key: string, value: Record<string, unknown>): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: requiredEnv("RELEASE_BUCKET"), Key: key, Body: JSON.stringify(value),
    ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*",
  }));
}

export async function materializePresetWorld(
  preset: PresetObservation,
  generationUuid: string,
  createdAt: string,
): Promise<WorldRecord> {
  const proposed = newWorldRecord(preset, generationUuid, createdAt);
  const pointerKey = `worlds/${proposed.worldId}/release.json`;
  try {
    await createJsonObject(pointerKey, {
      schema_version: 1,
      world: proposed.worldId,
      desired_release: proposed.currentGeneration.release,
      active_release: null,
      updated_at: createdAt,
      updated_by: "world-materialization",
    });
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = await readJsonObject(pointerKey);
    if (existing.world !== proposed.worldId || existing.desired_release !== proposed.currentGeneration.release) {
      throw new Error("world_release_pointer_conflict");
    }
  }

  const recordKey = `worlds/${proposed.worldId}/world.json`;
  try {
    await createJsonObject(recordKey, worldRecordDocument(proposed));
    return proposed;
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = parseWorldRecord(await readJsonObject(recordKey));
    if (
      existing === null || existing.worldId !== proposed.worldId || existing.gameId !== proposed.gameId ||
      existing.preset.id !== proposed.preset.id || existing.preset.profileDigest !== proposed.preset.profileDigest ||
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
  worldId: string,
  connectionAddress: string,
): Promise<string> {
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildStartInput({ operationId, instanceId, worldId, requestedBy, connectionAddress })),
  }));
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: requiredEnv("WATCHDOG_STATE_MACHINE_ARN"), name: operationId,
    input: JSON.stringify(buildWatchdogInput({ operationId, instanceId, worldId, requestedBy, stopStateMachineArn: machineArn("stop") })),
  }));
  if (!started.executionArn) throw new Error("start execution did not return an ARN");
  return started.executionArn;
}

export async function stopSessionExecution(
  operationId: string,
  instanceId: string,
  requestedBy: string,
  worldId: string,
): Promise<string> {
  requireWorldId(worldId);
  const stopped = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("stop"), name: operationId,
    input: JSON.stringify(buildStopInput({ operationId, instanceId, worldId, requestedBy })),
  }));
  if (!stopped.executionArn) throw new Error("stop execution did not return an ARN");
  return stopped.executionArn;
}

// The pack a player installs: the same object the bot serves, presigned for an
// hour. A missing object is a normal answer — releases published before packs
// were part of publication have none — so it is reported, not thrown.
export async function packDownloadUrl(release: string): Promise<string | null> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const key = `packs/${release}.zip`;
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
