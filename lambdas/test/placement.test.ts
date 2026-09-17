import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SLOTS,
  PlacementConflict,
  SYSTEM_RESERVE_MIB,
  capacity,
  drainDecision,
  fleetRoomMiB,
  headroomLaunch,
  holdsHeadroom,
  markReady,
  markStopped,
  markTerminating,
  newHost,
  place,
  placementCandidates,
  portsForSlot,
  release,
  remaining,
  requirementsFor,
  reserve,
} from "../src/domain/placement.ts";
import type { Footprint, HostRecord, HostShape } from "../src/domain/placement.ts";

const NOW = 1_789_000_000;

// What EC2 answered a launch with; the module never chooses among these.
const SHAPES: readonly HostShape[] = [
  { instanceType: "m7i-flex.large", memoryMiB: 8 * 1024, vcpu: 2 },
  { instanceType: "r7i.large", memoryMiB: 16 * 1024, vcpu: 2 },
  { instanceType: "r7i.xlarge", memoryMiB: 32 * 1024, vcpu: 4 },
  { instanceType: "r7i.2xlarge", memoryMiB: 64 * 1024, vcpu: 8 },
];

const MODDED: Footprint = { memoryMiB: 6 * 1024, cores: 1 };
const FACTORIO: Footprint = { memoryMiB: 2 * 1024, cores: 0.5 };
const VANILLA: Footprint = { memoryMiB: 3 * 1024, cores: 0.5 };

function readyHost(hostId: string, shape: HostShape): HostRecord {
  return markReady(newHost(hostId, shape, NOW), NOW + 1);
}

test("a host's capacity leaves room for the system", () => {
  const room = capacity(SHAPES[0]!);
  assert.equal(room.memoryMiB, 8 * 1024 - SYSTEM_RESERVE_MIB);
  assert.equal(room.cores, 1.5);
});

test("with no host up, a launch asks for the footprint beside the system, and names no type", () => {
  assert.deepEqual(place([], MODDED, "techno"), { kind: "launch", requirements: { memoryMiB: 6 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 2 } });
  assert.deepEqual(requirementsFor(FACTORIO), { memoryMiB: 2 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 1 });
  assert.deepEqual(requirementsFor({ memoryMiB: 70 * 1024, cores: 3.5 }), { memoryMiB: 70 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 4 });
});

test("headroom keeps room free only while something runs, and names what to launch when it is short", () => {
  const idle = readyHost("i-1", SHAPES[0]!);
  assert.equal(headroomLaunch([idle], 8 * 1024), null);
  const busy = reserve(idle, { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 2);
  assert.equal(fleetRoomMiB([busy]), 1024);
  assert.deepEqual(headroomLaunch([busy], 8 * 1024), { memoryMiB: 8 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 1 });
  assert.equal(headroomLaunch([busy], 0), null);

  const spare = readyHost("i-2", SHAPES[1]!);
  assert.equal(headroomLaunch([busy, spare], 8 * 1024), null);
  assert.equal(holdsHeadroom([busy, spare], spare, 8 * 1024), true);
  assert.equal(holdsHeadroom([busy, spare, readyHost("i-3", SHAPES[1]!)], spare, 8 * 1024), false);
  assert.equal(holdsHeadroom([release(busy, "s1", NOW + 3), spare], spare, 8 * 1024), false);

  // An empty host that is the fleet's headroom is kept past any grace period.
  const emptied = release(reserve(spare, { sessionId: "s9", worldId: "w", footprint: FACTORIO, policy: "cold" }, NOW + 4), "s9", NOW + 5);
  assert.equal(drainDecision(emptied, NOW + 5000, 600, true), "keep");
  assert.equal(drainDecision(emptied, NOW + 5000, 600, false), "terminate");
});

test("a host with room is reused rather than a new one launched, and the tightest fit wins", () => {
  const roomy = readyHost("i-roomy", SHAPES[2]!);
  const tight = reserve(readyHost("i-tight", SHAPES[1]!), { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 2);
  assert.equal(remaining(tight).memoryMiB, 15 * 1024 - 6 * 1024);
  // Factorio fits both; the r7i.large with a Minecraft on it has less left over.
  assert.deepEqual(place([roomy, tight], FACTORIO, "factorio"), { kind: "reuse", hostId: "i-tight" });
  // A modded Minecraft no longer fits beside the first one; the roomy host takes it.
  assert.deepEqual(place([roomy, tight], MODDED, "magic"), { kind: "reuse", hostId: "i-roomy" });
});

test("the smallest host launches a second modded world beside nothing: a full host is not a candidate", () => {
  const first = reserve(readyHost("i-1", SHAPES[0]!), { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 2);
  assert.deepEqual(place([first], MODDED, "magic"), { kind: "launch", requirements: requirementsFor(MODDED) });
  // Two gigabytes do not fit either: 6 + 2 is more than 8 minus the reserve.
  assert.deepEqual(place([first], FACTORIO, "factorio"), { kind: "launch", requirements: requirementsFor(FACTORIO) });
  assert.deepEqual(place([first], { memoryMiB: 1024, cores: 0.5 }, "tiny"), { kind: "reuse", hostId: "i-1" });
});

test("reservations take the lowest free slot, and a slot names the ports", () => {
  let host = readyHost("i-1", SHAPES[3]!);
  host = reserve(host, { sessionId: "s1", worldId: "a", footprint: FACTORIO, policy: "cold" }, NOW + 2);
  host = reserve(host, { sessionId: "s2", worldId: "b", footprint: FACTORIO, policy: "cold" }, NOW + 3);
  host = release(host, "s1", NOW + 4);
  host = reserve(host, { sessionId: "s3", worldId: "c", footprint: FACTORIO, policy: "cold" }, NOW + 5);
  assert.deepEqual(host.reservations.map((reservation) => [reservation.sessionId, reservation.slot]), [["s2", 1], ["s3", 0]]);

  const minecraft = { game: 25565, rcon: 25575 };
  const factorio = { game: 34197, rcon: 27015 };
  assert.deepEqual(portsForSlot(minecraft, 0), minecraft);
  assert.deepEqual(portsForSlot(factorio, 0), factorio);
  assert.deepEqual(portsForSlot(minecraft, 1), { game: 30010, rcon: 30011 });
  assert.deepEqual(portsForSlot(factorio, 2), { game: 30020, rcon: 30021 });
  assert.throws(() => portsForSlot(minecraft, MAX_SLOTS), /slot must be/);
});

test("every port on a host is distinct, across slots and across games", () => {
  const games = [{ game: 25565, rcon: 25575 }, { game: 34197, rcon: 27015 }, { game: 16261, rcon: 27015 }];
  const seen = new Map<number, string>();
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    // Slot zero is one game's defaults; every other slot's window is game-independent.
    const ports = slot === 0 ? [portsForSlot(games[0]!, 0)] : games.map((game) => portsForSlot(game, slot));
    for (const pair of ports) {
      for (const port of [pair.game, pair.rcon]) {
        assert.equal(seen.has(port) && seen.get(port) !== `slot ${slot}`, false, `port ${port} reused by slot ${slot}`);
        seen.set(port, `slot ${slot}`);
        assert.ok(port < 65536);
      }
    }
  }
});

test("candidates are ranked best fit first, so a lost write falls through to the next host", () => {
  const roomy = readyHost("i-roomy", SHAPES[2]!);
  const tight = reserve(readyHost("i-tight", SHAPES[1]!), { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 2);
  const full = reserve(readyHost("i-full", SHAPES[0]!), { sessionId: "s2", worldId: "magic", footprint: MODDED, policy: "cold" }, NOW + 2);
  assert.deepEqual(placementCandidates([full, roomy, tight], FACTORIO, "factorio").map((host) => host.hostId), ["i-tight", "i-roomy"]);
  assert.deepEqual(placementCandidates([full], FACTORIO, "factorio"), []);
});

test("a reservation that does not fit is refused, in memory and in cores", () => {
  const host = readyHost("i-1", SHAPES[0]!);
  assert.throws(() => reserve(host, { sessionId: "s1", worldId: "w", footprint: { memoryMiB: 7 * 1024 + 1, cores: 1 }, policy: "cold" }, NOW + 2), PlacementConflict);
  assert.throws(() => reserve(host, { sessionId: "s1", worldId: "w", footprint: { memoryMiB: 1024, cores: 2 }, policy: "cold" }, NOW + 2), PlacementConflict);
  const placed = reserve(host, { sessionId: "s1", worldId: "w", footprint: VANILLA, policy: "cold" }, NOW + 2);
  assert.throws(() => reserve(placed, { sessionId: "s1", worldId: "w", footprint: VANILLA, policy: "cold" }, NOW + 3), PlacementConflict);
  assert.throws(() => reserve(newHost("i-2", SHAPES[0]!, NOW), { sessionId: "s9", worldId: "w", footprint: VANILLA, policy: "cold" }, NOW + 2), PlacementConflict);
});

test("the last session leaving starts the drain, and a start inside the grace period cancels it", () => {
  let host = readyHost("i-1", SHAPES[1]!);
  host = reserve(host, { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 2);
  host = reserve(host, { sessionId: "s2", worldId: "factorio", footprint: FACTORIO, policy: "cold" }, NOW + 3);
  host = release(host, "s1", NOW + 100);
  assert.equal(host.state, "ready");
  host = release(host, "s2", NOW + 200);
  assert.equal(host.state, "draining");
  assert.equal(host.drainingSinceEpochSeconds, NOW + 200);
  assert.equal(drainDecision(host, NOW + 500, 600), "keep");
  assert.equal(drainDecision(host, NOW + 800, 600), "terminate");

  const revived = reserve(host, { sessionId: "s3", worldId: "techno", footprint: MODDED, policy: "cold" }, NOW + 500);
  assert.equal(revived.state, "ready");
  assert.equal(revived.drainingSinceEpochSeconds, null);
  assert.equal(drainDecision(revived, NOW + 5000, 600), "keep");
  assert.throws(() => markTerminating(revived, NOW + 5000), PlacementConflict);
});

test("a warm world's host stops instead of terminating, and is a candidate for that world only", () => {
  let host = readyHost("i-1", SHAPES[0]!);
  host = reserve(host, { sessionId: "s1", worldId: "techno", footprint: MODDED, policy: "warm" }, NOW + 2);
  host = release(host, "s1", NOW + 100);
  assert.equal(host.keptWorldId, "techno");
  assert.equal(drainDecision(host, NOW + 100 + 600, 600), "stop");
  host = markStopped(host, NOW + 700);
  assert.equal(host.state, "stopped");

  assert.deepEqual(place([host], MODDED, "techno"), { kind: "reuse", hostId: "i-1" });
  assert.deepEqual(place([host], MODDED, "magic"), { kind: "launch", requirements: requirementsFor(MODDED) });
  assert.throws(() => reserve(host, { sessionId: "s2", worldId: "magic", footprint: MODDED, policy: "cold" }, NOW + 800), PlacementConflict);

  const restarted = markReady(host, NOW + 900);
  const again = reserve(restarted, { sessionId: "s3", worldId: "techno", footprint: MODDED, policy: "warm" }, NOW + 901);
  assert.equal(again.keptWorldId, null);
  assert.equal(again.state, "ready");
});

test("every transition moves the version, so a stale writer loses", () => {
  const created = newHost("i-1", SHAPES[0]!, NOW);
  const ready = markReady(created, NOW + 1);
  const placed = reserve(ready, { sessionId: "s1", worldId: "w", footprint: VANILLA, policy: "cold" }, NOW + 2);
  const drained = release(placed, "s1", NOW + 3);
  const gone = markTerminating(drained, NOW + 4);
  assert.deepEqual([created, ready, placed, drained, gone].map((host) => host.version), [0, 1, 2, 3, 4]);
  assert.equal(gone.state, "terminating");
  assert.throws(() => release(gone, "s1", NOW + 5), PlacementConflict);
});
