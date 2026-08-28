import { DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { GetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";

import type { LifecycleRecord } from "../domain/lifecycle.ts";
import type { ControlPlaneSources, HostObservation, OperationObservation, ReleasePointerObservation } from "./read-model.ts";

type OperationMachine = Readonly<{ type: OperationObservation["type"]; arn: string }>;

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
    if ((type !== "start" && type !== "stop" && type !== "promote") || typeof arn !== "string" || !arn) {
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

async function listRunningOperations(): Promise<readonly OperationObservation[]> {
  const groups = await Promise.all(operationMachines().map(async (machine) => {
    const response = await sfn.send(new ListExecutionsCommand({ stateMachineArn: machine.arn, statusFilter: "RUNNING", maxResults: 10 }));
    return (response.executions ?? []).flatMap((execution) => execution.name && execution.startDate && execution.executionArn ? [{
      id: execution.name,
      type: machine.type,
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
