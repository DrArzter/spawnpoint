import { DescribeInstancesCommand, type EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeExecutionCommand, ListExecutionsCommand, type SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

/** A launched host as the sweeper judges it (ADR-0054). */
export type FleetInstance = Readonly<{ hostId: string; state: string; launchedAtEpochSeconds: number }>;

/** What the fleet sweeper asks of EC2 and of the drain machine. */
export type FleetOps = Readonly<{
  managedInstances: () => Promise<readonly FleetInstance[]>;
  /** The hosts a running drain execution names. */
  runningDrainHosts: (drainArn: string) => Promise<Set<string>>;
  /** Starts a drain; one already started under the name is not an error. */
  startDrain: (drainArn: string, name: string, hostId: string) => Promise<void>;
  terminate: (hostId: string) => Promise<void>;
}>;

export function awsFleetOps(ec2: Pick<EC2Client, "send">, states: Pick<SFNClient, "send">): FleetOps {
  return {
    async managedInstances() {
      const instances: FleetInstance[] = [];
      let nextToken: string | undefined;
      do {
        const page = await ec2.send(new DescribeInstancesCommand({ // NOSONAR paginated: the next token comes from the previous page
          Filters: [
            { Name: "tag:ManagedBy", Values: ["spawnpoint-fleet"] },
            { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
          ],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }));
        for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
          if (!instance.InstanceId || !instance.State?.Name || !instance.LaunchTime) continue;
          instances.push({ hostId: instance.InstanceId, state: instance.State.Name, launchedAtEpochSeconds: Math.floor(instance.LaunchTime.getTime() / 1000) });
        }
        nextToken = page.NextToken;
      } while (nextToken);
      return instances;
    },
    async runningDrainHosts(drainArn) {
      const hosts = new Set<string>();
      let nextToken: string | undefined;
      do {
        const page = await states.send(new ListExecutionsCommand({ // NOSONAR paginated: the next token comes from the previous page
          stateMachineArn: drainArn,
          statusFilter: "RUNNING",
          ...(nextToken ? { nextToken } : {}),
        }));
        const arns = (page.executions ?? []).flatMap((execution) => execution.executionArn ? [execution.executionArn] : []);
        const details = await Promise.all(arns.map((executionArn) => states.send(new DescribeExecutionCommand({ executionArn })))); // NOSONAR one page at a time, within the paginated listing
        for (const detail of details) {
          if (!detail.input) continue;
          const input: unknown = JSON.parse(detail.input);
          if (typeof input === "object" && input !== null && "hostId" in input && typeof input.hostId === "string") hosts.add(input.hostId);
        }
        nextToken = page.nextToken;
      } while (nextToken);
      return hosts;
    },
    async startDrain(drainArn, name, hostId) {
      try {
        await states.send(new StartExecutionCommand({ stateMachineArn: drainArn, name, input: JSON.stringify({ hostId }) }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ExecutionAlreadyExists")) throw error;
      }
    },
    async terminate(hostId) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [hostId] }));
    },
  };
}
