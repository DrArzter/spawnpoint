import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { CatalogGame } from "../src/control-plane/catalog.ts";
import type { ConsoleEntry, ConsoleInvocation, ConsoleRecord, ConsoleRecords, ConsoleTarget } from "../src/control-plane/console.ts";
import { consoleFeature, type ConsoleSession } from "../src/handlers/api/console.ts";

// The console feature against its ports (ADR-0063): no cloud API, no table
// shape. The adapters have their own tests.

const operator: Identity = { id: "identity-1", displayName: "Operator", roleId: "operator", directGrants: [] };
const target: ConsoleTarget = { hostId: "i-0123456789abcdef0", worldId: "world-a", slot: "2" };
const catalog: readonly CatalogGame[] = [{
  id: "game-a", code: "GA", displayName: "Game A", connectPort: 1000,
  worlds: [{ id: "world-a", displayName: "World A", profileId: "main", sessionControl: "v1", connectivity: "raw", placement: "fleet" }],
}];

function fakes(session: ConsoleSession, answers: readonly ConsoleInvocation[] = []) {
  const sent: { target: ConsoleTarget; command: string }[] = [];
  const stored: ConsoleRecord[] = [];
  const settled: { id: string; status: string }[] = [];
  const queue = [...answers];
  const records: ConsoleRecords = {
    append: async (record) => { stored.push(record); },
    recent: async (gameId, worldId) => stored
      .filter((record) => record.gameId === gameId && record.entry.worldId === worldId)
      .map((record) => ({ entry: record.entry, hostId: record.hostId }))
      .reverse(),
    settle: async (entry, result) => { settled.push({ id: entry.id, status: result.status }); },
  };
  const feature = consoleFeature({
    catalog: async () => catalog,
    session: async () => session,
    gateway: {
      send: async (to, command) => { sent.push({ target: to, command }); return `command-${sent.length}`; },
      read: async () => queue.shift() ?? { status: "InProgress", responseCode: null, output: "", error: "" },
    },
    records,
    now: () => new Date("2026-11-24T12:00:00.000Z"),
  });
  return { feature, sent, stored, settled };
}

const body = (command: string) => JSON.stringify({ command });
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test("a command goes to the world's host as base64 and is recorded as pending", async () => {
  const { feature, sent, stored } = fakes({ kind: "ready", sessionId: "session-1", target });
  const response = await feature.runConsoleCommand(operator, "game-a", "world-a", body("say $(id)"), { clientId: "client-1", name: "Agent" });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(sent.map((entry) => entry.target), [target]);
  assert.equal(Buffer.from(sent[0]!.command, "base64").toString("utf8"), "say $(id)");
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0], entry: undefined }, { entry: undefined, gameId: "game-a", sessionId: "session-1", hostId: target.hostId, agentClientId: "client-1" });
  assert.deepEqual((json(response).entry as ConsoleEntry), {
    id: "command-1", at: "2026-11-24T12:00:00.000Z", identityId: "identity-1", displayName: "Operator",
    agent: "Agent", worldId: "world-a", command: "say $(id)", status: "pending", output: null,
  });
});

test("nothing is sent to a world that is unknown, not ready or has no host", async () => {
  for (const [session, world, command, status, error] of [
    [{ kind: "ready", sessionId: "s", target }, "world-b", "list", 404, "unknown_world"],
    [{ kind: "ready", sessionId: "s", target }, "world-a", "", 400, "invalid_command"],
    [{ kind: "not_ready" }, "world-a", "list", 409, "session_not_ready"],
    [{ kind: "no_host" }, "world-a", "list", 409, "console_unavailable"],
  ] as const) {
    const { feature, sent, stored } = fakes(session);
    const response = await feature.runConsoleCommand(operator, "game-a", world, body(command));
    assert.equal(response.statusCode, status, error);
    assert.equal(json(response).error, error);
    assert.deepEqual([sent.length, stored.length], [0, 0]);
  }
});

test("the history settles a pending command once its host has answered", async () => {
  const { feature, settled } = fakes({ kind: "ready", sessionId: "s", target }, [
    { status: "InProgress", responseCode: null, output: "", error: "" },
    { status: "Success", responseCode: 0, output: "There are 0 players online\n", error: "" },
  ]);
  await feature.runConsoleCommand(operator, "game-a", "world-a", body("list"));
  const first = json(await feature.consoleHistory("game-a", "world-a")).entries as ConsoleEntry[];
  assert.equal(first[0]?.status, "pending");
  assert.deepEqual(settled, []);
  const second = json(await feature.consoleHistory("game-a", "world-a")).entries as ConsoleEntry[];
  assert.deepEqual([second[0]?.status, second[0]?.output], ["succeeded", "There are 0 players online"]);
  assert.deepEqual(settled, [{ id: "command-1", status: "succeeded" }]);
});

test("an agent reads only a command among the world's recent ones", async () => {
  const { feature } = fakes({ kind: "ready", sessionId: "s", target });
  await feature.runConsoleCommand(operator, "game-a", "world-a", body("list"));
  assert.equal((await feature.consoleCommandResult("game-a", "world-a", "command-1")).statusCode, 200);
  assert.equal((await feature.consoleCommandResult("game-a", "world-a", "command-9")).statusCode, 404);
});
