import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

import { dynamoReleaseStateReader } from "../src/control-plane/dynamo-release-state.ts";
import { checkReleaseUsable, noReleaseState, releaseUsability, requireReleaseUsable } from "../src/control-plane/release-usable.ts";

test("only a live release, or one the table does not know, is usable", () => {
  assert.equal(releaseUsability(null), "usable");
  assert.equal(releaseUsability("live"), "usable");
  assert.equal(releaseUsability("retiring"), "release_retired");
  assert.equal(releaseUsability("retired"), "release_retired");
  assert.equal(releaseUsability("building"), "release_not_ready");
});

test("the helper asks for the release's own game, preset and version", async () => {
  const asked: string[][] = [];
  const result = await checkReleaseUsable(async (...args) => { asked.push(args); return "retired"; }, "minecraft", "industrial", "1.2");
  assert.equal(result, "release_retired");
  assert.deepEqual(asked, [["minecraft", "industrial", "1.2"]]);
  assert.equal(await checkReleaseUsable(noReleaseState, "minecraft", "industrial", "1.2"), "usable");
});

test("a caller that stops with an error code gets the same answer", async () => {
  await requireReleaseUsable(async () => "live", "minecraft", "industrial", "1.2");
  await assert.rejects(requireReleaseUsable(async () => "retiring", "minecraft", "industrial", "1.2"), /release_retired/);
});

function table(item: Record<string, unknown> | undefined) {
  const commands: GetCommand[] = [];
  return { commands, client: { send: async (command: GetCommand) => { commands.push(command); return { Item: item }; } } as never };
}

test("the reader gets one release item by key, consistently", async () => {
  const { client, commands } = table({ state: "retiring" });
  assert.equal(await dynamoReleaseStateReader(client, "refs")("minecraft", "industrial", "1.2"), "retiring");
  assert.deepEqual(commands[0]!.input, { TableName: "refs", Key: { pk: "release#minecraft/industrial/1.2", sk: "meta" }, ConsistentRead: true });
});

test("no item is null, and a state the code does not know is an error, never usable", async () => {
  assert.equal(await dynamoReleaseStateReader(table(undefined).client, "refs")("minecraft", "industrial", "1.2"), null);
  await assert.rejects(dynamoReleaseStateReader(table({ state: "archived" }).client, "refs")("minecraft", "industrial", "1.2"), /release_state_unreadable/);
  await assert.rejects(dynamoReleaseStateReader(table({}).client, "refs")("minecraft", "industrial", "1.2"), /release_state_unreadable/);
});

test("a table that cannot be read stops the use of the release", async () => {
  const failing = { send: async () => { throw new Error("ProvisionedThroughputExceededException"); } } as never;
  await assert.rejects(checkReleaseUsable(dynamoReleaseStateReader(failing, "refs"), "minecraft", "industrial", "1.2"), /Throughput/);
});
