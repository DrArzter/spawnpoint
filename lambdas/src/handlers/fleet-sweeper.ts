import { EC2Client } from "@aws-sdk/client-ec2";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient } from "@aws-sdk/client-sfn";

import { fleetSweepAction } from "../domain/fleet-sweep.ts";
import { WARM_HOST_RETENTION_SECONDS, type HostRecord } from "../domain/placement.ts";
import { awsFleetOps, type FleetInstance } from "../control-plane/aws-fleet-ops.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

// The composition root: the clients, then the ports over them.
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = dynamoTable(document);
const fleet = awsFleetOps(new EC2Client({}), new SFNClient({}));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function hostRecord(tableName: string, hostId: string): Promise<HostRecord | null> {
  const result = await table.get({
    TableName: tableName,
    Key: { server_id: `host#${hostId}` },
    ConsistentRead: true,
  });
  return (result.Item?.host as HostRecord | undefined) ?? null;
}


async function inspectInstance(
  instance: FleetInstance,
  table: string,
  drainArn: string,
  now: number,
  grace: number,
  warmRetention: number,
  activeDrains: () => Promise<Set<string>>,
): Promise<string | null> {
  const { hostId } = instance;
  const host = await hostRecord(table, hostId);
  const action = fleetSweepAction(instance.state, instance.launchedAtEpochSeconds, host, now, grace, warmRetention);
  switch (action) {
    case "drain": {
      // The drain rechecks the current record, reservations, headroom and a
      // warm host's retention after its own grace period. A sweep never
      // decides to delete EC2.
      const running = await activeDrains();
      if (running.has(hostId)) return null;
      const name = `sweep-${hostId}-${Math.floor(now / 1800)}`;
      await fleet.startDrain(drainArn, name, hostId);
      running.add(hostId);
      console.info("restarted stale Fleet drain", hostId);
      return null;
    }
    case "terminate":
      // A terminating record cannot take a new reservation. This retries
      // the EC2 call that may have failed after the fenced DDB transition.
      await fleet.terminate(hostId);
      console.info("retried Fleet termination", hostId);
      return null;
    case "alarm":
      return `${hostId}: ${host?.state ?? "no host record"}, EC2 ${instance.state}`;
    case "none":
      return null;
  }
}

export async function handler(): Promise<void> {
  const table = required("LIFECYCLE_TABLE_NAME");
  const drainArn = required("DRAIN_STATE_MACHINE_ARN");
  const grace = Number(required("DRAIN_GRACE_SECONDS"));
  if (!Number.isSafeInteger(grace) || grace < 0) throw new Error("DRAIN_GRACE_SECONDS must be a non-negative integer");
  const warmRetention = Number(process.env.WARM_HOST_RETENTION_SECONDS ?? WARM_HOST_RETENTION_SECONDS);
  if (!Number.isSafeInteger(warmRetention) || warmRetention < 0) throw new Error("WARM_HOST_RETENTION_SECONDS must be a non-negative integer");
  const now = Math.floor(Date.now() / 1000);
  const alarms: string[] = [];
  let activeDrainsPromise: Promise<Set<string>> | undefined;
  const activeDrains = () => activeDrainsPromise ??= fleet.runningDrainHosts(drainArn);
  const instances = await fleet.managedInstances();
  // Each host is its own decision; the running drains are read once and shared.
  const found = await Promise.all(instances.map((instance) => inspectInstance(instance, table, drainArn, now, grace, warmRetention, activeDrains)));
  alarms.push(...found.filter((alarm): alarm is string => Boolean(alarm)));
  if (alarms.length > 0) throw new Error(`Fleet needs manual review: ${alarms.join("; ")}`);
}
