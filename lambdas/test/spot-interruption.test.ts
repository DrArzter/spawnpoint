import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LifecycleConflict,
  beginMoving,
  beginSession,
  isIdleStopEligible,
  recordPlayerObservation,
  beginStopping,
  type LifecycleRecord,
} from "../src/domain/lifecycle.ts";
import type { HostRecord } from "../src/domain/placement.ts";
import type { SessionVolume } from "../src/domain/session-volume.ts";
import { parseExecutionEvent, renderNotification } from "../src/domain/notifications.ts";
import {
  interruptionEvent,
  markHostSessionsMoving,
  moveHostSessions,
  type InterruptionPorts,
  type SessionMove,
} from "../src/control-plane/spot-interruption.ts";

// ADR-0102, step 5: what a Spot interruption does to the sessions on the host.

const NOW = 1_790_000_000;
const WATCHDOG = "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-idle-watchdog-v2:op-1-watchdog";

function ready(overrides: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    schemaVersion: 1, serverId: "world#alpha", desiredState: "running", observedState: "ready",
    activeSessionId: "s1", activeWorldId: "alpha", activeSessionAddress: "alpha.example.test:25565",
    readyAtEpochSeconds: NOW - 600, fencingToken: 3, lease: null,
    idle: { watchdogExecutionId: WATCHDOG, consecutiveEmpty: 2, lastObservationId: "c1", lastObservedAtEpochSeconds: NOW - 60, playersOnline: 0 },
    updatedAtEpochSeconds: NOW - 60, ...overrides,
  };
}

test("only a ready session moves, and a moving one is not observed, stopped or idle", () => {
  const moving = beginMoving(ready(), "s1", NOW);
  assert.equal(moving.observedState, "moving");
  assert.equal(moving.activeSessionAddress, "alpha.example.test:25565", "the address stays");
  assert.equal(beginMoving(moving, "s1", NOW + 1), moving, "a repeated warning changes nothing");
  assert.throws(() => beginMoving(ready({ observedState: "starting" }), "s1", NOW), LifecycleConflict);
  assert.throws(() => beginMoving(ready({ observedState: "stopping", desiredState: "stopped" }), "s1", NOW), LifecycleConflict);
  assert.throws(() => beginMoving(ready(), "s2", NOW), LifecycleConflict);

  assert.equal(recordPlayerObservation(moving, "s1", WATCHDOG, "c2", 0, NOW), moving);
  assert.equal(isIdleStopEligible(moving, "s1", WATCHDOG, 1), false);
  const lease = { ownerOperationId: "op-stop", fencingToken: 4, expiresAtEpochSeconds: NOW + 600 };
  assert.throws(() => beginStopping({ ...moving, lease }, { ownerOperationId: "op-stop", fencingToken: 4 }, "s1", NOW), LifecycleConflict);
});

test("a moving session starts again under its own id; no other session may begin", () => {
  const lease = { ownerOperationId: "move-1", fencingToken: 4, expiresAtEpochSeconds: NOW + 600 };
  const moving = { ...beginMoving(ready(), "s1", NOW), lease };
  const ownership = { ownerOperationId: "move-1", fencingToken: 4 };
  const resumed = beginSession(moving, ownership, "s1", "alpha", NOW);
  assert.equal(resumed.observedState, "starting");
  assert.equal(resumed.activeSessionId, "s1");
  assert.equal(resumed.idle, null, "the old watchdog no longer owns it");
  assert.throws(() => beginSession(moving, ownership, "s2", "alpha", NOW), LifecycleConflict);
});

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    schemaVersion: 1, hostId: "i-0123456789abcdef0", shape: { memoryMiB: 16384, vcpu: 2 } as HostRecord["shape"],
    provenance: "launched", market: "spot", state: "ready",
    reservations: [
      { sessionId: "s1", worldId: "alpha", slot: 0, footprint: { memoryMiB: 4096, cores: 1 } as never, policy: "cold" },
      { sessionId: "s9", worldId: "beta", slot: 1, footprint: { memoryMiB: 4096, cores: 1 } as never, policy: "cold" },
    ],
    drainingSinceEpochSeconds: null, keptWorldId: null, version: 1, updatedAtEpochSeconds: NOW - 600, ...overrides,
  };
}

function fakes(records: Record<string, LifecycleRecord>, hostRecord: HostRecord | null, volumes: SessionVolume[] = []) {
  const lifecycle = new Map(Object.entries(records).map(([key, record]) => [key, { revision: 1, record }]));
  let current = hostRecord === null ? null : { revision: 1, record: hostRecord };
  const started: SessionMove[] = [];
  const ports: InterruptionPorts = {
    placement: {
      readHost: async () => current,
      compareAndSetHost: async (_id, revision, record) => {
        if (current?.revision !== revision) return false;
        current = { revision: revision + 1, record };
        return true;
      },
    },
    lifecycle: {
      read: async (key) => lifecycle.get(key) ?? null,
      compareAndSet: async (key, revision, record) => {
        if (lifecycle.get(key)?.revision !== revision) return false;
        lifecycle.set(key, { revision: revision + 1, record });
        return true;
      },
    },
    volumes: { list: async () => volumes },
    moves: {
      origin: async (arn) => (arn === WATCHDOG ? { gameId: "minecraft", worldName: "Alpha" } : null),
      start: async (move) => {
        started.push(move);
        return `arn:start:${move.operationId}`;
      },
    },
  };
  return { ports, lifecycle, started, host: () => current };
}

const quiet = { info: () => {}, warn: () => {} };

test("the warning marks each ready session on the host as moving", async () => {
  const beta = ready({ serverId: "world#beta", activeSessionId: "s9", activeWorldId: "beta", observedState: "starting" });
  const { ports, lifecycle } = fakes({ "world#alpha": ready(), "world#beta": beta }, host());
  const result = await markHostSessionsMoving(ports, "i-0123456789abcdef0", NOW, quiet);
  assert.deepEqual(result, { hostId: "i-0123456789abcdef0", worlds: ["alpha"], skipped: ["beta"] });
  assert.equal(lifecycle.get("world#alpha")?.record.observedState, "moving");
  assert.equal(lifecycle.get("world#beta")?.record.observedState, "starting", "a start in flight compensates on its own");
});

test("a host the fleet did not launch, or that has no record, is left alone", async () => {
  for (const record of [null, host({ provenance: "configured" })]) {
    const { ports, lifecycle } = fakes({ "world#alpha": ready() }, record);
    assert.deepEqual((await markHostSessionsMoving(ports, "i-0123456789abcdef0", NOW, quiet)).worlds, []);
    assert.equal(lifecycle.get("world#alpha")?.record.observedState, "ready");
  }
});

test("termination releases each moving session and starts it again with its volume", async () => {
  const volume: SessionVolume = { volumeId: "vol-0123456789abcdef0", state: "in-use", createdAtEpochSeconds: NOW - 900, sessionId: "s1", worldId: "alpha" };
  const { ports, started, host: current } = fakes({ "world#alpha": beginMoving(ready(), "s1", NOW - 120), "world#beta": ready({ serverId: "world#beta", activeSessionId: "s9", activeWorldId: "beta" }) }, host(), [volume]);
  const result = await moveHostSessions(ports, "i-0123456789abcdef0", NOW, quiet);
  assert.deepEqual(result.worlds, ["alpha"]);
  assert.deepEqual(result.skipped, ["beta"]);
  assert.deepEqual(started, [{
    operationId: `move-${NOW}-s1`, serverId: "world#alpha", sessionId: "s1", worldId: "alpha",
    gameId: "minecraft", worldName: "Alpha", volumeId: "vol-0123456789abcdef0",
    footprint: { memoryMiB: 4096, cores: 1 },
  }], "the move asks for the footprint the session was placed with");
  assert.deepEqual(current()?.record.reservations.map((reservation) => reservation.sessionId), ["s9"]);
});

test("a moving session whose volume is gone starts again from S3", async () => {
  const { ports, started } = fakes({ "world#alpha": beginMoving(ready(), "s1", NOW - 120) }, host());
  await moveHostSessions(ports, "i-0123456789abcdef0", NOW, quiet);
  assert.equal(started[0]?.volumeId, "");
});

test("the rules' three events are read; anything else is ignored", () => {
  const ec2 = (detailType: string, detail: Record<string, unknown>) => ({ source: "aws.ec2", "detail-type": detailType, detail });
  assert.deepEqual(interruptionEvent(ec2("EC2 Spot Instance Interruption Warning", { "instance-id": "i-0123456789abcdef0", "instance-action": "terminate" })),
    { kind: "warning", hostId: "i-0123456789abcdef0" });
  assert.deepEqual(interruptionEvent(ec2("EC2 Instance State-change Notification", { "instance-id": "i-0123456789abcdef0", state: "terminated" })),
    { kind: "terminated", hostId: "i-0123456789abcdef0" });
  assert.equal(interruptionEvent(ec2("EC2 Instance State-change Notification", { "instance-id": "i-0123456789abcdef0", state: "stopped" })), null);
  assert.equal(interruptionEvent(ec2("EC2 Spot Instance Interruption Warning", { "instance-id": "../x" })), null);
  assert.deepEqual(interruptionEvent({ source: "spawnpoint.host", "detail-type": "Sessions saved for interruption", detail: { instanceId: "i-0123456789abcdef0", saved: ["alpha"], failed: [] } }),
    { kind: "saved", hostId: "i-0123456789abcdef0", report: { saved: ["alpha"], failed: [] } });
  assert.equal(interruptionEvent({ source: "spawnpoint.other", "detail-type": "Sessions saved for interruption", detail: {} }), null);
});

test("a move says the world is moving, then that it is back", () => {
  const event = (status: string, output?: Record<string, unknown>) => parseExecutionEvent({
    stateMachineArn: "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-start-server-v2",
    status, name: "move-1790000000-s1",
    input: JSON.stringify({ serverId: "world#alpha", worldName: "Alpha", move: true, moveVolumeId: "vol-0123456789abcdef0" }),
    ...(output === undefined ? {} : { output: JSON.stringify(output) }),
  });
  assert.equal(renderNotification(event("RUNNING")!), "[MOVING] Alpha: its machine was reclaimed. It moves to a new one at the same address.");
  assert.equal(renderNotification(event("SUCCEEDED", { connectionAddress: "alpha.example.test:25565" })!), "[BACK] Alpha is back: alpha.example.test:25565");
  assert.match(renderNotification(event("FAILED")!) ?? "", /^\[FAILED\] Alpha could not move/);
});

type State = { Type: string; Next?: string; Default?: string; Parameters?: Record<string, unknown>; Choices?: Array<Record<string, unknown>> };

async function load(name: string): Promise<Record<string, State>> {
  const template = await readFile(new URL(`../../workflows/${name}`, import.meta.url), "utf8");
  return (JSON.parse(template.replaceAll("${allowed_instance_types}", "[\"m7i.*\"]").replaceAll(/\$\{[^}]+\}/g, "arn:aws:test")) as { States: Record<string, State> }).States;
}

test("a move brings its volume to the new host's zone; any other start creates one", async () => {
  const states = await load("start-server-v2.asl.json.tftpl");
  assert.equal(states["Describe Session Host Zone"]?.Next, "Route Moved Session Volume");
  assert.equal(states["Route Moved Session Volume"]?.Choices?.[0]?.Next, "Adopt Moved Session Volume");
  assert.equal(states["Route Moved Session Volume"]?.Default, "Create Session Volume");
  assert.equal(states["Adopt Moved Session Volume"]?.Next, "Describe Created Session Volume");
  const available = states["Session Volume Available"]?.Choices ?? [];
  assert.deepEqual(available[0], { Not: { Variable: "$.sessionVolume.observed.zone", StringEqualsPath: "$.sessionVolume.host.zone" }, Next: "Session Volume Unavailable" });
  assert.ok(JSON.stringify(available).includes("in-use"), "a move waits while the reclaimed host lets the volume go");
});

test("a watchdog whose host is gone reconciles only a session it owns that is not moving", async () => {
  const states = await load("idle-watchdog-v2.asl.json.tftpl");
  assert.equal(states["Host Still Running"]?.Default, "Read Session Before Reconcile");
  assert.equal(states["Session Moving"]?.Choices?.[0]?.Next, "Session Moved");
  assert.equal(states["Session Moving"]?.Default, "Session Moved");
  assert.equal(states["Watchdog Still Owns Session"]?.Choices?.[0]?.Next, "Reconcile Externally Stopped Host");
  assert.equal(states["Watchdog Still Owns Session"]?.Default, "Session Moved");
  assert.equal(renderNotification(parseExecutionEvent({
    stateMachineArn: "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-idle-watchdog-v2",
    status: "SUCCEEDED", name: "op-1-watchdog", output: JSON.stringify({ status: "session_moved" }),
  })!), null);
});
