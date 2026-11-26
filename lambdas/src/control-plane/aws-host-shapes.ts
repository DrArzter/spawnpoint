import { DescribeInstancesCommand, DescribeInstanceTypesCommand, type EC2Client, type _InstanceType } from "@aws-sdk/client-ec2";

import type { HostShape } from "../domain/placement.ts";

/*
 * The shape of each host a metrics read covers, so a percentage can be shown as
 * cores or bytes. EC2 is the source, not the fleet host record: the configured
 * host has no record, and a launched host's record goes when it terminates, at
 * about the time EC2 stops describing it. A host EC2 no longer describes has no
 * shape, and its readings carry no capacity.
 */
export type HostShapeReader = (instanceIds: readonly string[]) => Promise<ReadonlyMap<string, HostShape>>;

export function createHostShapeReader(ec2: Pick<EC2Client, "send">): HostShapeReader {
  // An instance type's shape never changes, so it is read once per container.
  const byType = new Map<string, HostShape>();

  // A filter, not InstanceIds: an id EC2 no longer knows is left out instead of failing the call.
  async function typesOf(instanceIds: readonly string[]): Promise<Map<string, string>> {
    const types = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const page = await ec2.send(new DescribeInstancesCommand({ // NOSONAR paginated: the next token comes from the previous page
        Filters: [{ Name: "instance-id", Values: [...instanceIds] }],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
        if (instance.InstanceId && instance.InstanceType) types.set(instance.InstanceId, instance.InstanceType);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return types;
  }

  async function learn(instanceTypes: readonly string[]): Promise<void> {
    const unknown = [...new Set(instanceTypes)].filter((type) => !byType.has(type));
    if (unknown.length === 0) return;
    let nextToken: string | undefined;
    do {
      const page = await ec2.send(new DescribeInstanceTypesCommand({ // NOSONAR paginated: the next token comes from the previous page
        InstanceTypes: unknown as _InstanceType[],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      for (const info of page.InstanceTypes ?? []) {
        const vcpu = info.VCpuInfo?.DefaultVCpus;
        const memoryMiB = info.MemoryInfo?.SizeInMiB;
        if (info.InstanceType && vcpu && memoryMiB) byType.set(info.InstanceType, { instanceType: info.InstanceType, vcpu, memoryMiB });
      }
      nextToken = page.NextToken;
    } while (nextToken);
  }

  return async (instanceIds) => {
    if (instanceIds.length === 0) return new Map();
    try {
      const types = await typesOf(instanceIds);
      await learn([...types.values()]);
      const shapes = new Map<string, HostShape>();
      for (const [instanceId, type] of types) {
        const shape = byType.get(type);
        if (shape) shapes.set(instanceId, shape);
      }
      return shapes;
    } catch (error) {
      // Capacity is an addition to the readings; without it the chart still answers.
      console.warn("host_shape_read_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return new Map();
    }
  };
}
