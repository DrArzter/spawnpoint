import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { CatalogGame } from "../src/control-plane/catalog.ts";
import type { ConsoleInvocation, ConsoleTarget } from "../src/control-plane/console.ts";
import { playerNamesIn, redactLog, type WorldLogRecord, type WorldLogRecords, worldLogResult } from "../src/control-plane/world-log.ts";
import type { ConsoleSession } from "../src/handlers/api/console.ts";
import { worldLogFeature } from "../src/handlers/api/world-log.ts";

// A world's log (ADR-0094): redaction rules and the feature against its ports.

test("addresses, ids and emails are replaced by tokens", () => {
  const lines = redactLog([
    "[12:00:01] [Server thread/INFO]: Connection from 203.0.113.7:51234 and 10.0.0.1",
    "[12:00:02] [Server thread/INFO]: Peer [2001:db8::1]:25565 and fe80:0:0:0:0:0:0:1",
    "[12:00:03] [Server thread/INFO]: Ticket 123e4567-e89b-12d3-a456-426614174000 for ops@example.org",
  ].join("\n"), []);
  assert.deepEqual(lines, [
    "[12:00:01] [Server thread/INFO]: Connection from <ip> and <ip>",
    "[12:00:02] [Server thread/INFO]: Peer [<ip>]:25565 and <ip>",
    "[12:00:03] [Server thread/INFO]: Ticket <uuid> for <email>",
  ]);
});

test("a clock time is not taken for an IPv6 address", () => {
  assert.deepEqual(redactLog("[23:59:59] tick 12:30:45.123 took 50ms", []), ["[23:59:59] tick 12:30:45.123 took 50ms"]);
});

test("a player keeps one token through the log, and chat text is removed", () => {
  const log = [
    "UUID of player Alice_1 is 123e4567-e89b-12d3-a456-426614174000",
    "Alice_1[/198.51.100.4:40000] logged in with entity id 7",
    "Alice_1 joined the game",
    "<Alice_1> my password is hunter2",
    "Bob left the server",
    "Alice_1 lost connection: Disconnected",
    "Carol was slain by a zombie",
  ].join("\n");
  assert.deepEqual(redactLog(log, ["Carol"]), [
    "UUID of player player-1 is <uuid>",
    "player-1[/<ip>] logged in with entity id 7",
    "player-1 joined the game",
    "<player-1> [chat removed]",
    "player-2 left the server",
    "player-1 lost connection: Disconnected",
    "player-3 was slain by a zombie",
  ]);
});

test("a name inside a longer name or a word is left alone", () => {
  assert.deepEqual(redactLog("Al joined the game\nAlbert loaded the Alchemy mod", []), ["player-1 joined the game", "Albert loaded the Alchemy mod"]);
});

test("names are found in the order the log mentions them", () => {
  assert.deepEqual(playerNamesIn("Bob joined the game\nUUID of player Ann is x\nBob left the game"), ["Bob", "Ann"]);
});

test("the host's answer is read in the log's words", () => {
  const invocation = (status: string, responseCode: number | null = null): ConsoleInvocation => ({ status, responseCode, output: "line", error: "" });
  assert.deepEqual(worldLogResult(invocation("InProgress")), { status: "pending", text: null });
  assert.deepEqual(worldLogResult(invocation("Success", 0)), { status: "succeeded", text: "line" });
  assert.deepEqual(worldLogResult(invocation("TimedOut")), { status: "timed_out", text: null });
  assert.deepEqual(worldLogResult(invocation("Failed", 3)), { status: "unavailable", text: null });
  assert.deepEqual(worldLogResult(invocation("Failed", 9)), { status: "unavailable", text: null });
  assert.deepEqual(worldLogResult(invocation("Failed", 1)), { status: "failed", text: null });
});

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const target: ConsoleTarget = { hostId: "i-0123456789abcdef0", worldId: "world-a", slot: "1" };
const catalog: readonly CatalogGame[] = [{
  id: "game-a", code: "GA", displayName: "Game A", connectPort: 1000,
  worlds: [{ id: "world-a", displayName: "World A", profileId: "main", sessionControl: "v1", connectivity: "raw", placement: "fleet" }],
}];

function fakes(session: ConsoleSession, answer: ConsoleInvocation = { status: "InProgress", responseCode: null, output: "", error: "" }) {
  const stored: WorldLogRecord[] = [];
  const asked: ConsoleTarget[] = [];
  const records: WorldLogRecords = {
    append: async (record) => { stored.push(record); },
    find: async (gameId, worldId, readId) => stored.find((record) => record.gameId === gameId && record.worldId === worldId && record.id === readId) ?? null,
  };
  const feature = worldLogFeature({
    catalog: async () => catalog,
    session: async () => session,
    gateway: { readLog: async (to) => { asked.push(to); return `read-${asked.length}`; }, read: async () => answer },
    records,
    knownNames: async () => ["Dana"],
    now: () => new Date("2026-11-24T12:00:00.000Z"),
  });
  return { feature, stored, asked };
}

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test("a log read goes to the world's host and is recorded without the log", async () => {
  const { feature, stored, asked } = fakes({ kind: "ready", sessionId: "session-1", target });
  const response = await feature.requestLog(owner, "game-a", "world-a");
  assert.equal(response.statusCode, 202);
  assert.deepEqual(asked, [target]);
  assert.deepEqual(stored, [{ id: "read-1", at: "2026-11-24T12:00:00.000Z", gameId: "game-a", worldId: "world-a", hostId: target.hostId, identityId: "identity-1" }]);
  assert.deepEqual(json(response).read, { id: "read-1", at: "2026-11-24T12:00:00.000Z", status: "pending", lines: null });
});

test("a log read is refused where no game answers", async () => {
  assert.equal((await fakes({ kind: "not_ready" }).feature.requestLog(owner, "game-a", "world-a")).statusCode, 409);
  assert.equal((await fakes({ kind: "no_host" }).feature.requestLog(owner, "game-a", "world-a")).statusCode, 409);
  assert.equal((await fakes({ kind: "not_ready" }).feature.requestLog(owner, "game-a", "world-b")).statusCode, 404);
});

test("the log is redacted with the world's whitelist when it is read", async () => {
  const { feature } = fakes({ kind: "ready", sessionId: "session-1", target }, { status: "Success", responseCode: 0, output: "Dana was here from 192.0.2.9\n", error: "" });
  await feature.requestLog(owner, "game-a", "world-a");
  const response = await feature.logResult("game-a", "world-a", "read-1");
  assert.deepEqual(json(response).read, { id: "read-1", at: "2026-11-24T12:00:00.000Z", status: "succeeded", lines: ["player-1 was here from <ip>"] });
  assert.equal((await feature.logResult("game-a", "world-b", "read-1")).statusCode, 404, "a read belongs to its own world");
});
