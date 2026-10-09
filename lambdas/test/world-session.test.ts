import assert from "node:assert/strict";
import test from "node:test";

import { acquireLease, beginSession, beginStopping, initialLifecycleRecord, markSessionReady, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import { blockingOperations, holdsWorld, locateWorldSession, operationWorldId, sessionLifecycleKey, worldHost } from "../src/control-plane/world-session.ts";

// ADR-0062: a fleet world's sessions live on a record of its own, so two
// worlds of one game run at once; configured worlds share their game's.

function running(serverId: string, worldId: string, sessionId = `session-${worldId}`): LifecycleRecord {
  const lease = acquireLease(initialLifecycleRecord(serverId, 100), "op", 100, 300);
  return markSessionReady(beginSession(lease.record, lease.ownership, sessionId, worldId, 101), lease.ownership, sessionId, 102);
}

test("a fleet world's record is its own; a configured world's is its game's", () => {
  assert.equal(sessionLifecycleKey("minecraft", "minecraft-rostik-1a2b3c4d", "fleet"), "world#minecraft-rostik-1a2b3c4d");
  assert.equal(sessionLifecycleKey("minecraft", "world", "configured"), "minecraft");
  assert.notEqual(sessionLifecycleKey("factorio", "factorio", "fleet"), "factorio", "a world named like its game never shares the game's record");
});

test("a record holds a world while it runs or moves, not once it is fully stopped", () => {
  const ready = running("world#a", "a");
  assert.equal(holdsWorld(ready, "a"), true);
  assert.equal(holdsWorld(ready, "b"), false);
  const lease = acquireLease(ready, "stop", 500, 300);
  assert.equal(holdsWorld(beginStopping(lease.record, lease.ownership, "session-a", 501), "a"), true, "stopping still holds it");
  assert.equal(holdsWorld(initialLifecycleRecord("world#a", 1), "a"), false);
  assert.equal(holdsWorld(null, "a"), false);
});

test("two fleet worlds of one game each find their own session, and neither sees the other", () => {
  const rostik = running("world#rostik", "rostik");
  const located = locateWorldSession("minecraft", "rostik", "fleet", { game: null, own: rostik });
  assert.deepEqual(located, { serverId: "world#rostik", record: rostik });
  const idle = locateWorldSession("minecraft", "vanilla-two", "fleet", { game: null, own: null });
  assert.deepEqual(idle, { serverId: "world#vanilla-two", record: null }, "the next start of this world begins on its own record");
});

test("a fleet session begun on its game's record before the split runs to its stop there", () => {
  const legacy = running("minecraft", "rostik");
  assert.deepEqual(locateWorldSession("minecraft", "rostik", "fleet", { game: legacy, own: null }), { serverId: "minecraft", record: legacy });
  assert.deepEqual(
    locateWorldSession("minecraft", "other", "fleet", { game: legacy, own: null }),
    { serverId: "world#other", record: null },
    "another fleet world is not held back by it",
  );
  const own = running("world#rostik", "rostik");
  assert.equal(locateWorldSession("minecraft", "rostik", "fleet", { game: legacy, own }).serverId, "world#rostik", "its own record wins once it holds the world");
});

test("a configured world's session is its game's record only while that record names it", () => {
  const vanilla = running("minecraft", "vanilla");
  assert.deepEqual(locateWorldSession("minecraft", "vanilla", "configured", { game: vanilla, own: null }), { serverId: "minecraft", record: vanilla });
  assert.deepEqual(locateWorldSession("minecraft", "world", "configured", { game: vanilla, own: null }), { serverId: "minecraft", record: null });
  const unnamed = { ...vanilla, activeWorldId: null };
  assert.equal(locateWorldSession("minecraft", "world", "configured", { game: unnamed, own: null }).record, unnamed, "a record that names no world could be anyone's");
});

test("an operation belongs to the world its input names", () => {
  assert.equal(operationWorldId(JSON.stringify({ serverId: "world#rostik", worldId: "rostik" })), "rostik");
  assert.equal(operationWorldId(JSON.stringify({ release: "1.2" })), null);
  assert.equal(operationWorldId(JSON.stringify({ worldId: "Not A World" })), null);
  assert.equal(operationWorldId("{broken"), null);
  assert.equal(operationWorldId(undefined), null);
});

test("a fleet world waits only for its own operations; a configured world for anything on the configured host", () => {
  const placement = (worldId: string) => ({ rostik: "fleet", other: "fleet", world: "configured", vanilla: "configured" } as const)[worldId];
  const operations = [
    { id: "start-other", worldId: "other" },
    { id: "start-vanilla", worldId: "vanilla" },
  ];
  assert.deepEqual(blockingOperations(operations, "rostik", placement), [], "another fleet world's start does not hold this one");
  assert.deepEqual(blockingOperations(operations, "other", placement).map((operation) => operation.id), ["start-other"]);
  assert.deepEqual(blockingOperations(operations, "world", placement).map((operation) => operation.id), ["start-vanilla"], "the configured host runs one at a time");
  const promotion = { id: "promote", worldId: null };
  assert.deepEqual(blockingOperations([promotion], "rostik", placement), [promotion], "an operation that names no world blocks every world");
  assert.deepEqual(blockingOperations([{ id: "unknown", worldId: "gone" }], "world", placement).length, 1, "a world nobody knows is treated as the configured host's");
});

test("a world's host is the one its own session runs on, never another world's", () => {
  const rostik = running("minecraft", "rostik");
  const game = { game: rostik, own: null };
  // The configured host runs Rostik; Vanilla, of the same game, runs nowhere.
  const vanilla = locateWorldSession("minecraft", "vanilla", "configured", game).record;
  assert.equal(worldHost("configured", vanilla, null, ["i-configured"]), null);
  assert.deepEqual(worldHost("configured", locateWorldSession("minecraft", "rostik", "configured", game).record, null, ["i-configured"]), { hostId: "i-configured", slot: "" });

  // Two fleet worlds of one game, each on the host and slot its session holds.
  const a = running("world#a", "a", "session-a");
  const b = running("world#b", "b", "session-b");
  assert.deepEqual(worldHost("fleet", a, { hostId: "i-one", slot: 0 }, ["i-configured"]), { hostId: "i-one", slot: "0" });
  assert.deepEqual(worldHost("fleet", b, { hostId: "i-one", slot: 1 }, ["i-configured"]), { hostId: "i-one", slot: "1" });
  assert.equal(worldHost("fleet", a, null, ["i-configured"]), null, "an unplaced fleet session is never the configured host's");
  assert.equal(worldHost("fleet", null, null, ["i-configured"]), null);
  assert.equal(worldHost("configured", rostik, null, ["i-one", "i-two"]), null, "two configured hosts leave no single answer");
});
