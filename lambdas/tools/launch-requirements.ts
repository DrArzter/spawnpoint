// What a launch would ask EC2 for, per world, and — with credentials — whether
// EC2 has any instance type that answers it. The check the rollout names for
// the allowed families: a requirement nothing satisfies is found here, not at
// ten o'clock when a start is refused.
//
//   node lambdas/tools/launch-requirements.ts            print the requirements
//   node lambdas/tools/launch-requirements.ts --verify   also ask EC2 (needs credentials, AWS_REGION)

import { EC2Client, GetInstanceTypesFromInstanceRequirementsCommand } from "@aws-sdk/client-ec2";

import { gameCatalog, launchFamilies, launchRequirementsForWorld } from "../src/control-plane/catalog.ts";
import type { LaunchRequirements } from "../src/domain/placement.ts";

const verify = process.argv.includes("--verify");
const worlds = gameCatalog.flatMap((game) => game.worlds.map((world) => ({ game: game.id, world: world.id, requirements: launchRequirementsForWorld(world.id) })));

console.log(`${"world".padEnd(20)} ${"game".padEnd(10)} ${"min MiB".padStart(8)} ${"min vCPU".padStart(9)}`);
for (const entry of worlds) {
  console.log(`${entry.world.padEnd(20)} ${entry.game.padEnd(10)} ${String(entry.requirements.memoryMiB).padStart(8)} ${String(entry.requirements.vcpu).padStart(9)}`);
}
console.log(`\nallowed families: ${launchFamilies.join(", ")}`);

if (!verify) process.exit(0);

// The same requirements an instant Fleet would carry, so what this previews is
// what a launch asks; only the region and credentials come from the environment.
async function matchingTypes(client: EC2Client, requirements: LaunchRequirements): Promise<string[]> {
  const types: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new GetInstanceTypesFromInstanceRequirementsCommand({
      ArchitectureTypes: ["x86_64"],
      VirtualizationTypes: ["hvm"],
      InstanceRequirements: {
        MemoryMiB: { Min: requirements.memoryMiB },
        VCpuCount: { Min: requirements.vcpu },
        AllowedInstanceTypes: [...launchFamilies],
        BurstablePerformance: "excluded",
      },
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));
    for (const match of page.InstanceTypes ?? []) if (match.InstanceType) types.push(match.InstanceType);
    nextToken = page.NextToken;
  } while (nextToken);
  return types;
}

const client = new EC2Client({});
let failures = 0;
for (const entry of worlds) {
  const types = await matchingTypes(client, entry.requirements);
  if (types.length === 0) {
    failures += 1;
    console.error(`FAIL ${entry.world}: no instance type in the allowed families meets ${JSON.stringify(entry.requirements)}`);
  } else {
    console.log(`ok   ${entry.world}: ${types.length} types answer, e.g. ${types.slice(0, 4).join(", ")}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
