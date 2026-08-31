import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import { buildStartInput, buildStopInput, buildWatchdogInput } from "../domain/telegram-bot.ts";
import type { ControlPlaneSources, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";

type MachineType = OperationObservation["type"] | "publishPack";
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
      (type !== "start" && type !== "stop" && type !== "promote" && type !== "publishPack") ||
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

function isSessionOperation(type: MachineType): type is OperationObservation["type"] {
  return type === "start" || type === "stop" || type === "promote";
}

async function listRunningOperations(): Promise<readonly OperationObservation[]> {
  // Publishing an uploaded pack runs beside a session rather than against it:
  // it writes to the release bucket and never touches the host, so it must not
  // appear as an operation in progress that refuses a start.
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
};

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
): Promise<string> {
  requireWorldId(worldId);
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("start"), name: operationId,
    input: JSON.stringify(buildStartInput({ operationId, instanceId, worldId, requestedBy, connectionAddress: requiredEnv("CONNECTION_ADDRESS") })),
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

// A pack is hundreds of megabytes, so the panel puts it into S3 itself with a
// presigned URL and this process never sees the bytes. The key is composed here
// rather than accepted from the caller: an uploader chooses the file, never the
// object it lands on.
export async function packUploadTarget(uploadId: string): Promise<Readonly<{ key: string; url: string }>> {
  const key = `uploads/${uploadId}.zip`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: requiredEnv("RELEASE_BUCKET"), Key: key, ContentType: "application/zip" }),
    { expiresIn: 3600 },
  );
  return { key, url };
}

export async function startPackPublishExecution(
  operationId: string,
  args: Readonly<{
    uploadKey: string;
    release: string;
    game: string;
    gameVersion: string;
    loaderVersion: string;
    requestedBy: string;
  }>,
): Promise<string> {
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machineArn("publishPack"),
    name: operationId,
    input: JSON.stringify({ operationId, ...args }),
  }));
  if (!started.executionArn) throw new Error("pack publish execution did not return an ARN");
  return started.executionArn;
}
