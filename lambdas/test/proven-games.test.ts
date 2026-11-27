import assert from "node:assert/strict";
import test from "node:test";
import { DescribeExecutionCommand, ListExecutionsCommand, SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createProvenGamesReader, gameProvedByStart } from "../src/control-plane/aws-proven-games.ts";
import { readControlPlaneSnapshot, type ControlPlaneSources } from "../src/control-plane/read-model.ts";
import { provenGameKey } from "../src/domain/proven-games.ts";
import { dynamoLifecycleStores } from "../src/lifecycle/dynamo-lifecycle-stores.ts";

// ADR-0109: a game is proven once a session of it was ready in this deployment.

const START = "arn:aws:states:eu-central-1:123456789012:stateMachine:start";

function clients(stored: ReadonlySet<string>, starts: ReadonlyArray<Readonly<{ input: unknown; output: unknown }>>) {
  const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-central-1" }));
  const sfn = new SFNClient({ region: "eu-central-1" });
  const calls = { get: 0, describe: 0 };
  document.send = (async (command: unknown) => {
    assert.ok(command instanceof GetCommand);
    calls.get += 1;
    const key = String(command.input.Key?.server_id);
    return stored.has(key) ? { Item: { game_id: key } } : {};
  }) as never;
  sfn.send = (async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) return { executions: starts.map((_, index) => ({ executionArn: `run-${index}` })) };
    assert.ok(command instanceof DescribeExecutionCommand);
    calls.describe += 1;
    const run = starts[Number(String(command.input.executionArn).slice(4))]!;
    return { input: JSON.stringify(run.input), output: JSON.stringify(run.output) };
  }) as never;
  return { document, sfn, calls };
}

function reader(stored: ReadonlySet<string>, starts: ReadonlyArray<Readonly<{ input: unknown; output: unknown }>>, clock = { now: 0 }) {
  const { document, sfn, calls } = clients(stored, starts);
  const read = createProvenGamesReader({
    document, sfn, tableName: () => "lifecycle", machines: () => [{ type: "start", arn: START }],
    gameIds: () => ["minecraft", "factorio", "valheim"], now: () => clock.now,
  });
  return { read, calls };
}

test("a stored proof proves its game, and the finished starts fill in only for a ready one", async () => {
  const { read } = reader(new Set([provenGameKey("minecraft")]), [
    { input: { gameId: "factorio" }, output: { status: "ready" } },
    { input: { gameId: "valheim" }, output: { status: "failed" } },
  ]);
  assert.deepEqual([...await read()].sort(), ["factorio", "minecraft"]);
});

test("the starts are not read when every game has its proof, and an answer is kept a minute", async () => {
  const clock = { now: 0 };
  const { read, calls } = reader(new Set(["minecraft", "factorio", "valheim"].map(provenGameKey)), [], clock);
  await read();
  await read();
  assert.deepEqual(calls, { get: 3, describe: 0 });
  clock.now = 61_000;
  await read();
  assert.equal(calls.get, 6);
});

test("a start names its game by gameId, or by a serverId that is a game's own key", () => {
  assert.equal(gameProvedByStart({ gameId: "valheim", serverId: "world#a" }, { status: "ready" }), "valheim");
  assert.equal(gameProvedByStart({ serverId: "minecraft" }, { status: "ready" }), "minecraft");
  assert.equal(gameProvedByStart({ serverId: "world#a" }, { status: "ready" }), null);
  assert.equal(gameProvedByStart({ gameId: "valheim" }, { status: "failed" }), null);
});

test("the snapshot marks each game proven or not, and every game is proven without a reader", async () => {
  const sources = {
    listHosts: async () => [], readLifecycle: async () => null, listRunningOperations: async () => [],
    readReleasePointer: async () => ({ state: "unavailable", generationId: null, desiredRelease: null, activeRelease: null }),
  } as unknown as ControlPlaneSources;
  const without = await readControlPlaneSnapshot(sources, { includeInfrastructure: false, includeDesiredRelease: false });
  assert.ok(without.games.every((game) => game.proven));
  const withReader = await readControlPlaneSnapshot({ ...sources, listProvenGames: async () => new Set(["minecraft"]) }, { includeInfrastructure: false, includeDesiredRelease: false });
  assert.deepEqual(withReader.games.filter((game) => game.proven).map((game) => game.id), ["minecraft"]);
});

test("the coordinator's store writes a proof once, in snake_case, and a second write is not an error", async () => {
  const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-central-1" }));
  const puts: PutCommand[] = [];
  document.send = (async (command: unknown) => {
    assert.ok(command instanceof PutCommand);
    puts.push(command);
    if (puts.length > 1) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    return {};
  }) as never;
  const { gameProofStore } = dynamoLifecycleStores(document, "lifecycle");
  const proof = { gameId: "valheim", worldId: "w", firstReadyAt: "2026-11-27T00:00:00.000Z" };
  await gameProofStore.record(proof);
  await gameProofStore.record(proof);
  assert.deepEqual(puts[0]?.input.Item, { server_id: "proven#valheim", game_id: "valheim", world_id: "w", first_ready_at: "2026-11-27T00:00:00.000Z" });
  assert.equal(puts[0]?.input.ConditionExpression, "attribute_not_exists(server_id)");
});
