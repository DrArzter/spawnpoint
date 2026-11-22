// Adds a generation's holder to one release, before an operator script writes
// a world record or a release pointer that names it (ADR-0080, holder first).
// The script stops when this exits non-zero. There is no option to skip it.
//
//   node lambdas/tools/hold-release.ts <game> <preset> <release> <world> <generation> <role[,role...]>
//
// Needs AWS credentials and AWS_REGION; AWS_PROFILE and RELEASE_REFS_TABLE are optional.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { ReleaseHolders, parseHoldRequest } from "../src/control-plane/release-holders.ts";
import { ReleaseRefs } from "../src/control-plane/release-refs.ts";

const request = parseHoldRequest(process.argv.slice(2));
if (typeof request === "string") {
  console.error(`error: ${request}`);
  process.exit(2);
}

const holders = new ReleaseHolders(
  new ReleaseRefs(DynamoDBDocumentClient.from(new DynamoDBClient({}))),
  async () => { throw new Error("not used: the game and preset are arguments"); },
);
try {
  await holders.hold(request.identity, request.worldId, request.generationId, request.release, request.roles);
  console.log(`held=${request.identity.gameId}/${request.identity.presetId}/${request.release} holder=gen#${request.worldId}/${request.generationId} roles=${request.roles.join(",")}`);
} catch (error) {
  console.error(`error: the holder was not written: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
