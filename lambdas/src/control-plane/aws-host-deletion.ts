import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import { operationMachines } from "./aws.ts";
import type { HostDeletion, HostDeletionRun, PersistentHostDisks } from "./host-deletion.ts";

// The delete-host machine and the host's disks, as EC2 and Step Functions keep them (ADR-0100).

const ec2 = new EC2Client({});
const sfn = new SFNClient({});

async function readDisks(hostId: string): Promise<PersistentHostDisks | null> {
  try {
    const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [hostId] }));
    const instance = described.Reservations?.[0]?.Instances?.[0];
    if (instance === undefined) return null;
    const dataVolumeIds = (instance.BlockDeviceMappings ?? [])
      .filter((mapping) => mapping.DeviceName !== instance.RootDeviceName)
      .flatMap((mapping) => mapping.Ebs?.VolumeId ? [mapping.Ebs.VolumeId] : []);
    return { name: instance.Tags?.find((tag) => tag.Key === "Name")?.Value ?? null, dataVolumeIds };
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidInstanceID.NotFound") return null;
    throw error;
  }
}

async function start(run: HostDeletionRun): Promise<string> {
  const machine = operationMachines().find((candidate) => candidate.type === "host");
  if (machine === undefined) throw new Error("missing host state machine");
  const started = await sfn.send(new StartExecutionCommand({
    stateMachineArn: machine.arn,
    name: run.operationId,
    input: JSON.stringify({ ...run, dataVolumeIds: [...run.dataVolumeIds] }),
  }));
  if (!started.executionArn) throw new Error("host deletion did not return an ARN");
  return started.executionArn;
}

export const awsHostDeletion: HostDeletion = { readDisks, start };
