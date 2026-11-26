import assert from "node:assert/strict";
import test from "node:test";

import { configuredCatalog } from "./support/configured-worlds.ts";

import { PlacementConflict, SYSTEM_RESERVE_MIB } from "../src/domain/placement.ts";
import type { HostRecord, HostShape } from "../src/domain/placement.ts";
import { createPlacementCoordinator, resolveFootprint, type PlacementStore, type VersionedHost } from "../src/lifecycle/placement-coordinator.ts";

class MemoryFleet implements PlacementStore {
  hosts = new Map<string, VersionedHost>();
  failNextCompareAndSetOn: string | null = null;

  async readHost(hostId: string): Promise<VersionedHost | null> {
    return this.hosts.get(hostId) ?? null;
  }

  async listHosts(): Promise<readonly VersionedHost[]> {
    return [...this.hosts.values()];
  }

  async createHost(record: HostRecord): Promise<boolean> {
    if (this.hosts.has(record.hostId)) return false;
    this.hosts.set(record.hostId, { revision: 1, record });
    return true;
  }

  async compareAndSetHost(hostId: string, expectedRevision: number, record: HostRecord): Promise<boolean> {
    if (this.failNextCompareAndSetOn === hostId) {
      this.failNextCompareAndSetOn = null;
      return false;
    }
    const current = this.hosts.get(hostId);
    if (current?.revision !== expectedRevision) return false;
    this.hosts.set(hostId, { revision: expectedRevision + 1, record });
    return true;
  }
}

const SMALL: HostShape = { instanceType: "m7i-flex.large", memoryMiB: 8 * 1024, vcpu: 2 };
const LARGE: HostShape = { instanceType: "r7i.xlarge", memoryMiB: 32 * 1024, vcpu: 4 };

// A world smaller than its game's default, sized by its start request.
const VANILLA = { memoryMiB: 3 * 1024, cores: 0.5 };

function coordinator(fleet: MemoryFleet) {
  let now = 1_789_000_000;
  return createPlacementCoordinator(fleet, () => now++);
}

test("a footprint comes from the request, else the game, and a world nobody can size is refused", () => {
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "world", serverId: "minecraft" }), { memoryMiB: 7 * 1024, cores: 1 });
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "made-later", serverId: "factorio" }), { memoryMiB: 2 * 1024, cores: 0.5 });
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "world", footprint: { memoryMiB: 1024, cores: 0.25 } }), { memoryMiB: 1024, cores: 0.25 });
  assert.throws(() => resolveFootprint({ sessionId: "s", worldId: "made-later" }), PlacementConflict);
  assert.throws(() => resolveFootprint({ sessionId: "s", worldId: "made-later", serverId: "chess" }), PlacementConflict);
  // ADR-0062: the server id may be a fleet world's own record, which is no game.
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "made-later", gameId: "factorio", serverId: "world#made-later" }), { memoryMiB: 2 * 1024, cores: 0.5 });
  assert.throws(() => resolveFootprint({ sessionId: "s", worldId: "made-later", serverId: "world#made-later" }), PlacementConflict);
});

test("registering the host that exists today is idempotent, and it is ready", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const first = await coordinate({ action: "registerHost", hostId: "i-1", shape: SMALL, ready: true });
  assert.equal(first.host?.revision, 1);
  assert.equal(first.host?.record.state, "draining", "an empty host is on the clock from the moment it is up");
  const again = await coordinate({ action: "registerHost", hostId: "i-1", shape: SMALL, ready: true });
  assert.equal(again.host?.revision, 1);
  const listed = await coordinate({ action: "listHosts" });
  assert.equal(listed.hosts?.length, 1);
});

test("drain conclusion is fenced to the revision that was decided", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-fleet", shape: SMALL, ready: true, provenance: "launched" });
  const decided = await coordinate({ action: "decideDrain", hostId: "i-fleet", gracePeriodSeconds: 0 });
  const revision = decided.host?.revision;
  assert.equal(decided.drain, "terminate");
  assert.ok(revision !== undefined);
  await coordinate({ action: "reserveOnHost", hostId: "i-fleet", sessionId: "s1", worldId: "vanilla", serverId: "minecraft", footprint: VANILLA });
  await coordinate({ action: "releasePlacement", hostId: "i-fleet", sessionId: "s1" });
  await assert.rejects(coordinate({ action: "concludeDrain", hostId: "i-fleet", outcome: "terminate", expectedRevision: revision }), PlacementConflict);
  assert.equal(fleet.hosts.get("i-fleet")?.record.state, "draining");
});

test("with nothing up, placing asks for a launch; with a host up, it reserves a slot and is idempotent for the session", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const nothing = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "arrived-later", serverId: "minecraft" });
  assert.deepEqual(nothing.placement, { kind: "launch", requirements: { memoryMiB: 7 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 2 }, spot: true });

  await coordinate({ action: "registerHost", hostId: "i-1", shape: SMALL, ready: true });
  const placed = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  assert.deepEqual(placed.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const repeated = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  assert.deepEqual(repeated.placement, placed.placement);
  assert.equal(fleet.hosts.get("i-1")?.record.reservations.length, 1);
  assert.equal(fleet.hosts.get("i-1")?.record.state, "ready");

  // The small host is full; a second modded preset world asks for a launch.
  const second = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "arrived-later", serverId: "minecraft" });
  assert.equal(second.placement?.kind, "launch");
  // A smaller world does not fit beside it either (7 + 3 > 8 - 1).
  const small = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "vanilla", serverId: "minecraft", footprint: VANILLA });
  assert.equal(small.placement?.kind, "launch");
});

test("a lost conditional write falls through to the next candidate instead of failing the start", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-tight", shape: SMALL, ready: true });
  await coordinate({ action: "registerHost", hostId: "i-roomy", shape: LARGE, ready: true });
  // Best fit prefers the small host; its write is lost to a racing start.
  fleet.failNextCompareAndSetOn = "i-tight";
  const placed = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "vanilla", serverId: "minecraft", footprint: VANILLA });
  assert.deepEqual(placed.placement, { kind: "reuse", hostId: "i-roomy", slot: 0 });
});

test("reserving on a named host, releasing, and the drain that follows", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true });
  const one = await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  assert.deepEqual(one.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const again = await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  assert.deepEqual(again.placement, one.placement);
  // A world the catalog does not describe takes slot zero only, and that slot is held.
  await assert.rejects(coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s2", worldId: "vanilla", serverId: "minecraft", footprint: VANILLA }), PlacementConflict);
  await assert.rejects(coordinate({ action: "reserveOnHost", hostId: "i-9", sessionId: "s3", worldId: "world", serverId: "minecraft" }), PlacementConflict);

  const releasedOne = await coordinate({ action: "releasePlacement", hostId: "i-1", sessionId: "s1" });
  assert.equal(releasedOne.released, true);
  assert.equal(releasedOne.host?.record.state, "draining");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-1", gracePeriodSeconds: 600 })).drain, "keep");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-1", gracePeriodSeconds: 0 })).drain, "stop", "the configured host is never terminated");

  const launched = await coordinate({ action: "registerHost", hostId: "i-fleet", shape: LARGE, ready: true, provenance: "launched" });
  assert.equal(launched.host?.record.provenance, "launched");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-fleet", gracePeriodSeconds: 0 })).drain, "terminate");
  await coordinate({ action: "concludeDrain", hostId: "i-1", outcome: "stop" });
  assert.equal((await coordinate({ action: "getHost", hostId: "i-1" })).host?.record.state, "stopped");
  const concluded = await coordinate({ action: "concludeDrain", hostId: "i-fleet", outcome: "terminate" });
  assert.equal(concluded.host?.record.state, "terminating");
  await assert.rejects(coordinate({ action: "concludeDrain", hostId: "i-fleet", outcome: "terminate" }), PlacementConflict);
});

test("releasing what was never reserved is not a failure, so a stop that predates placement still verifies", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  assert.deepEqual(await coordinate({ action: "releasePlacement", hostId: "i-none", sessionId: "s1" }), { released: false, host: null });
  await coordinate({ action: "registerHost", hostId: "i-1", shape: SMALL, ready: true });
  const unknownSession = await coordinate({ action: "releasePlacement", hostId: "i-1", sessionId: "s-old" });
  assert.equal(unknownSession.released, false);
  assert.equal(unknownSession.host?.revision, 1);
});

test("an empty host that is the fleet's headroom is kept; without headroom it drains", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-busy", shape: SMALL, ready: true });
  await coordinate({ action: "reserveOnHost", hostId: "i-busy", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  await coordinate({ action: "registerHost", hostId: "i-spare", shape: LARGE, ready: true, provenance: "launched" });
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-spare", gracePeriodSeconds: 0, headroomMiB: 8 * 1024 })).drain, "keep");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-spare", gracePeriodSeconds: 0 })).drain, "terminate");
  await coordinate({ action: "releasePlacement", hostId: "i-busy", sessionId: "s1" });
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-spare", gracePeriodSeconds: 0, headroomMiB: 8 * 1024 })).drain, "terminate", "nothing is kept when nothing runs");
});

test("a stop finds where its session runs, and can give the slot back knowing only the session", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  assert.deepEqual(await coordinate({ action: "findPlacement", sessionId: "s1" }), { placement: null });
  await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true });
  await coordinate({ action: "registerHost", hostId: "i-2", shape: LARGE, ready: true });
  await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  await coordinate({ action: "reserveOnHost", hostId: "i-2", sessionId: "s2", worldId: "vanilla", serverId: "minecraft", footprint: VANILLA });
  assert.deepEqual((await coordinate({ action: "findPlacement", sessionId: "s2" })).placement, { kind: "reuse", hostId: "i-2", slot: 0 });
  const released = await coordinate({ action: "releasePlacement", sessionId: "s2" });
  assert.equal(released.released, true);
  assert.deepEqual(await coordinate({ action: "findPlacement", sessionId: "s2" }), { placement: null });
  assert.deepEqual(await coordinate({ action: "releasePlacement", sessionId: "s2" }), { released: false, host: null });
});

test("fleet-only placement ignores a configured host and launches from zero", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-home", shape: LARGE, ready: true });

  const portable = await coordinate({
    action: "placeSession",
    sessionId: "s1",
    worldId: "made-later",
    serverId: "factorio",
    eligibleProvenance: "launched",
  });
  assert.deepEqual(portable.placement, { kind: "launch", requirements: { memoryMiB: 3 * 1024, vcpu: 1 }, spot: true });

  await coordinate({ action: "registerHost", hostId: "i-fleet", shape: LARGE, ready: true, provenance: "launched" });
  const reused = await coordinate({
    action: "placeSession",
    sessionId: "s1",
    worldId: "made-later",
    serverId: "factorio",
    eligibleProvenance: "launched",
  });
  assert.deepEqual(reused.placement, { kind: "reuse", hostId: "i-fleet", slot: 0 });
});

test("a Zomboid world and a public world take slot zero only; the second of them on a host asks for a launch", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true });
  const pz = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "knox", serverId: "zomboid" });
  assert.deepEqual(pz.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const factorio = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "base", serverId: "factorio" });
  assert.equal(factorio.placement?.kind, "launch", "a dynamic world must reserve the public game port until its connection mode is known");
  const secondPz = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "louisville", serverId: "zomboid" });
  assert.equal(secondPz.placement?.kind, "launch", "slot zero is taken, so the second Zomboid needs a host of its own");

  const publicCatalogWorld = { id: "arena", displayName: "Arena", profileId: "p", sessionControl: "v1" as const, connectivity: "raw" as const };
  const { worldNeedsSlotZero } = await import("../src/control-plane/catalog.ts");
  assert.equal(worldNeedsSlotZero("arena", undefined, [{ id: "minecraft", code: "MC", displayName: "Minecraft", connectPort: 25565, worlds: [publicCatalogWorld] }]), true);
  assert.equal(worldNeedsSlotZero("world", undefined, configuredCatalog), false);
  assert.equal(worldNeedsSlotZero("knox", "zomboid"), true);
  assert.equal(worldNeedsSlotZero("base", "factorio"), true);
});

test("a warm placement keeps its launched host stopped for the world; a cold one lets it go; any other policy is refused", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-warm", shape: LARGE, ready: true, provenance: "launched" });
  await coordinate({ action: "registerHost", hostId: "i-cold", shape: LARGE, ready: true, provenance: "launched" });

  const warm = await coordinate({ action: "reserveOnHost", hostId: "i-warm", sessionId: "s1", worldId: "world-a", serverId: "minecraft", policy: "warm" });
  assert.equal(warm.placement?.kind, "reuse");
  assert.equal(fleet.hosts.get("i-warm")?.record.reservations[0]?.policy, "warm");
  await coordinate({ action: "releasePlacement", hostId: "i-warm", sessionId: "s1" });
  assert.equal(fleet.hosts.get("i-warm")?.record.keptWorldId, "world-a");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-warm", gracePeriodSeconds: 0 })).drain, "stop");

  await coordinate({ action: "reserveOnHost", hostId: "i-cold", sessionId: "s2", worldId: "world-b", serverId: "minecraft" });
  assert.equal(fleet.hosts.get("i-cold")?.record.reservations[0]?.policy, "cold", "a start that names no policy is cold");
  await coordinate({ action: "releasePlacement", hostId: "i-cold", sessionId: "s2" });
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-cold", gracePeriodSeconds: 0 })).drain, "terminate");

  const placed = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "world-c", serverId: "minecraft", policy: "warm", eligibleProvenance: "launched" });
  assert.equal(placed.placement?.kind, "reuse");
  const host = [...fleet.hosts.values()].find((candidate) => candidate.record.reservations.some((reservation) => reservation.sessionId === "s3"));
  assert.equal(host?.record.reservations.find((reservation) => reservation.sessionId === "s3")?.policy, "warm");

  await assert.rejects(coordinate({ action: "placeSession", sessionId: "s4", worldId: "world-d", serverId: "minecraft", policy: "hot" as never }), /policy must be cold or warm/);
  await assert.rejects(coordinate({ action: "reserveOnHost", hostId: "i-cold", sessionId: "s5", worldId: "world-e", serverId: "minecraft", policy: "" as never }), /policy must be cold or warm/);
});

test("a launch says whether the session may run on Spot: cold, and of a game that declares it (ADR-0102)", async () => {
  const coordinate = coordinator(new MemoryFleet());
  const cold = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "w1", gameId: "minecraft", policy: "cold" });
  assert.equal(cold.placement?.kind === "launch" && cold.placement.spot, true);
  const warm = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "w2", gameId: "minecraft", policy: "warm" });
  assert.equal(warm.placement?.kind === "launch" && warm.placement.spot, false);
  const undeclared = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "w3", gameId: "no-spot-game", footprint: VANILLA });
  assert.equal(undeclared.placement?.kind === "launch" && undeclared.placement.spot, false);
});

test("a Spot host takes only Spot-eligible sessions and records its market", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const registered = await coordinate({ action: "registerHost", hostId: "i-spot", shape: LARGE, ready: true, provenance: "launched", market: "spot" });
  assert.equal(registered.host?.record.market, "spot");

  const warm = await coordinate({ action: "placeSession", sessionId: "s-warm", worldId: "w1", gameId: "minecraft", policy: "warm", footprint: VANILLA });
  assert.equal(warm.placement?.kind, "launch", "a warm session needs a host that can stop");
  const undeclared = await coordinate({ action: "placeSession", sessionId: "s-other", worldId: "w2", gameId: "no-spot-game", footprint: VANILLA });
  assert.equal(undeclared.placement?.kind, "launch", "a game without capabilities.spot never lands on Spot");
  await assert.rejects(
    coordinate({ action: "reserveOnHost", hostId: "i-spot", sessionId: "s-warm", worldId: "w1", gameId: "minecraft", policy: "warm", footprint: VANILLA }),
    PlacementConflict,
  );

  const cold = await coordinate({ action: "placeSession", sessionId: "s-cold", worldId: "w3", gameId: "minecraft", policy: "cold", footprint: VANILLA });
  assert.deepEqual(cold.placement, { kind: "reuse", hostId: "i-spot", slot: 0 });
});

test("a host with no market is on demand and takes any session; an unknown market is refused", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const plain = await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true, provenance: "launched" });
  assert.equal(plain.host?.record.market, undefined, "off, the record is written as before");
  const warm = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "w1", gameId: "minecraft", policy: "warm", footprint: VANILLA });
  assert.equal(warm.placement?.kind, "reuse");
  await assert.rejects(
    coordinate({ action: "registerHost", hostId: "i-2", shape: LARGE, provenance: "launched", market: "reserved" as never }),
    /market must be on-demand or spot/,
  );
});

// ADR-0102: a world that chose On-Demand never asks for Spot and never lands on a Spot host.
test("an On-Demand world launches On-Demand and skips a Spot host with room", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const launch = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world", serverId: "minecraft", market: "on-demand" });
  assert.equal(launch.placement?.kind === "launch" && launch.placement.spot, false);
  await coordinate({ action: "registerHost", hostId: "i-spot", shape: SMALL, ready: true, provenance: "launched", market: "spot" });
  const skipped = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "world", serverId: "minecraft", market: "on-demand" });
  assert.equal(skipped.placement?.kind, "launch");
  const spot = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "other", serverId: "minecraft", market: "spot" });
  assert.deepEqual(spot.placement, { kind: "reuse", hostId: "i-spot", slot: 0 });
  await assert.rejects(coordinate({ action: "placeSession", sessionId: "s4", worldId: "world", serverId: "minecraft", market: "reserved" as never }));
});
