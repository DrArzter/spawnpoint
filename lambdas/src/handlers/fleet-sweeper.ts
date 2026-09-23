import { DescribeInstancesCommand, EC2Client, TerminateInstancesCommand, type Instance } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import { fleetSweepAction } from "../domain/fleet-sweep.ts";
import type { HostRecord } from "../domain/placement.ts";

const ec2 = new EC2Client({});
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const states = new SFNClient({});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function hostRecord(table: string, hostId: string): Promise<HostRecord | null> {
  const result = await document.send(new GetCommand({
    TableName: table,
    Key: { server_id: `host#${hostId}` },
    ConsistentRead: true,
  }));
  return (result.Item?.host as HostRecord | undefined) ?? null;
}

async function runningDrainHosts(drainArn: string): Promise<Set<string>> {
  const hosts = new Set<string>();
  let nextToken: string | undefined;
  do {
    const page = await states.send(new ListExecutionsCommand({
      stateMachineArn: drainArn,
      statusFilter: "RUNNING",
      ...(nextToken ? { nextToken } : {}),
    }));
    for (const execution of page.executions ?? []) {
      if (!execution.executionArn) continue;
      const detail = await states.send(new DescribeExecutionCommand({ executionArn: execution.executionArn }));
      if (!detail.input) continue;
      const input: unknown = JSON.parse(detail.input);
      if (typeof input === "object" && input !== null && "hostId" in input && typeof input.hostId === "string") {
        hosts.add(input.hostId);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return hosts;
}

async function inspectInstance(
  instance: Instance,
  table: string,
  drainArn: string,
  now: number,
  grace: number,
  activeDrains: () => Promise<Set<string>>,
): Promise<string | null> {
  const hostId = instance.InstanceId;
  if (!hostId || !instance.State?.Name || !instance.LaunchTime) return null;
  const host = await hostRecord(table, hostId);
  const action = fleetSweepAction(instance.State.Name, Math.floor(instance.LaunchTime.getTime() / 1000), host, now, grace);
  switch (action) {
    case "drain": {
      // The drain rechecks the current record, reservations and headroom
      // after its own grace period. A sweep never decides to delete EC2.
      const running = await activeDrains();
      if (running.has(hostId)) return null;
      const name = `sweep-${hostId}-${Math.floor(now / 1800)}`;
      try {
        await states.send(new StartExecutionCommand({ stateMachineArn: drainArn, name, input: JSON.stringify({ hostId }) }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ExecutionAlreadyExists")) throw error;
      }
      running.add(hostId);
      console.info("restarted stale Fleet drain", hostId);
      return null;
    }
    case "terminate":
      // A terminating record cannot take a new reservation. This retries
      // the EC2 call that may have failed after the fenced DDB transition.
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [hostId] }));
      console.info("retried Fleet termination", hostId);
      return null;
    case "alarm":
      return `${hostId}: ${host?.state ?? "no host record"}, EC2 ${instance.State.Name}`;
    case "none":
      return null;
  }
}

export async function handler(): Promise<void> {
  const table = required("LIFECYCLE_TABLE_NAME");
  const drainArn = required("DRAIN_STATE_MACHINE_ARN");
  const grace = Number(required("DRAIN_GRACE_SECONDS"));
  if (!Number.isSafeInteger(grace) || grace < 0) throw new Error("DRAIN_GRACE_SECONDS must be a non-negative integer");
  const now = Math.floor(Date.now() / 1000);
  const alarms: string[] = [];
  let activeDrainsPromise: Promise<Set<string>> | undefined;
  const activeDrains = () => activeDrainsPromise ??= runningDrainHosts(drainArn);
  let nextToken: string | undefined;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:ManagedBy", Values: ["spawnpoint-fleet"] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const alarm = await inspectInstance(instance, table, drainArn, now, grace, activeDrains);
        if (alarm) alarms.push(alarm);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  if (alarms.length > 0) throw new Error(`Fleet needs manual review: ${alarms.join("; ")}`);
}
