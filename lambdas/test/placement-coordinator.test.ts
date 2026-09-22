import assert from "node:assert/strict";
import test from "node:test";

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

function coordinator(fleet: MemoryFleet) {
  let now = 1_789_000_000;
  return createPlacementCoordinator(fleet, () => now++);
}

test("a footprint comes from the request, the world, or the game, in that order, and a world nobody can size is refused", () => {
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "world" }), { memoryMiB: 7 * 1024, cores: 1 });
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "vanilla" }), { memoryMiB: 3 * 1024, cores: 0.5 });
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "made-later", serverId: "factorio" }), { memoryMiB: 2 * 1024, cores: 0.5 });
  assert.deepEqual(resolveFootprint({ sessionId: "s", worldId: "world", footprint: { memoryMiB: 1024, cores: 0.25 } }), { memoryMiB: 1024, cores: 0.25 });
  assert.throws(() => resolveFootprint({ sessionId: "s", worldId: "made-later" }), PlacementConflict);
  assert.throws(() => resolveFootprint({ sessionId: "s", worldId: "made-later", serverId: "chess" }), PlacementConflict);
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

test("with nothing up, placing asks for a launch; with a host up, it reserves a slot and is idempotent for the session", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  const bound = await coordinate({ action: "placeSession", sessionId: "s0", worldId: "world" });
  assert.deepEqual(bound.placement, { kind: "refused", reason: "bound_to_configured_host" }, "a legacy world cannot be launched for; its save is on the configured host");
  const nothing = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "arrived-later", serverId: "minecraft" });
  assert.deepEqual(nothing.placement, { kind: "launch", requirements: { memoryMiB: 7 * 1024 + SYSTEM_RESERVE_MIB, vcpu: 2 } });

  await coordinate({ action: "registerHost", hostId: "i-1", shape: SMALL, ready: true });
  const placed = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world" });
  assert.deepEqual(placed.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const repeated = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world" });
  assert.deepEqual(repeated.placement, placed.placement);
  assert.equal(fleet.hosts.get("i-1")?.record.reservations.length, 1);
  assert.equal(fleet.hosts.get("i-1")?.record.state, "ready");

  // The small host is full; a second modded preset world asks for a launch.
  const second = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "arrived-later", serverId: "minecraft" });
  assert.equal(second.placement?.kind, "launch");
  // The legacy vanilla world does not fit beside it either (7 + 3 > 8 - 1), and being bound it is refused.
  const vanilla = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "vanilla" });
  assert.equal(vanilla.placement?.kind, "refused");
});

test("a lost conditional write falls through to the next candidate instead of failing the start", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-tight", shape: SMALL, ready: true });
  await coordinate({ action: "registerHost", hostId: "i-roomy", shape: LARGE, ready: true });
  // Best fit prefers the small host; its write is lost to a racing start.
  fleet.failNextCompareAndSetOn = "i-tight";
  const placed = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "vanilla" });
  assert.deepEqual(placed.placement, { kind: "reuse", hostId: "i-roomy", slot: 0 });
});

test("reserving on a named host, releasing, and the drain that follows", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true });
  const one = await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s1", worldId: "world", serverId: "minecraft" });
  assert.deepEqual(one.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const two = await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s2", worldId: "made-later", serverId: "factorio" });
  assert.deepEqual(two.placement, { kind: "reuse", hostId: "i-1", slot: 1 });
  const again = await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s2", worldId: "made-later", serverId: "factorio" });
  assert.deepEqual(again.placement, two.placement);
  await assert.rejects(coordinate({ action: "reserveOnHost", hostId: "i-9", sessionId: "s3", worldId: "world" }), PlacementConflict);

  const releasedOne = await coordinate({ action: "releasePlacement", hostId: "i-1", sessionId: "s1" });
  assert.equal(releasedOne.released, true);
  assert.equal(releasedOne.host?.record.state, "ready");
  assert.equal((await coordinate({ action: "decideDrain", hostId: "i-1", gracePeriodSeconds: 600 })).drain, "keep");

  const releasedTwo = await coordinate({ action: "releasePlacement", hostId: "i-1", sessionId: "s2" });
  assert.equal(releasedTwo.host?.record.state, "draining");
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
  await coordinate({ action: "reserveOnHost", hostId: "i-busy", sessionId: "s1", worldId: "world" });
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
  await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s1", worldId: "world" });
  await coordinate({ action: "reserveOnHost", hostId: "i-1", sessionId: "s2", worldId: "vanilla" });
  assert.deepEqual((await coordinate({ action: "findPlacement", sessionId: "s2" })).placement, { kind: "reuse", hostId: "i-1", slot: 1 });
  const released = await coordinate({ action: "releasePlacement", sessionId: "s2" });
  assert.equal(released.released, true);
  assert.deepEqual(await coordinate({ action: "findPlacement", sessionId: "s2" }), { placement: null });
  assert.deepEqual(await coordinate({ action: "releasePlacement", sessionId: "s2" }), { released: false, host: null });
});

test("a legacy world is bound to the configured host: it never lands on a launched one and never asks for a launch", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-fleet", shape: LARGE, ready: true, provenance: "launched" });
  assert.deepEqual((await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world" })).placement, { kind: "refused", reason: "bound_to_configured_host" });
  // A preset world is free to take the launched host.
  assert.deepEqual((await coordinate({ action: "placeSession", sessionId: "s2", worldId: "made-later", serverId: "factorio" })).placement, { kind: "reuse", hostId: "i-fleet", slot: 0 });
  await coordinate({ action: "registerHost", hostId: "i-home", shape: SMALL, ready: true });
  assert.deepEqual((await coordinate({ action: "placeSession", sessionId: "s1", worldId: "world" })).placement, { kind: "reuse", hostId: "i-home", slot: 0 });
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
  assert.deepEqual(portable.placement, { kind: "launch", requirements: { memoryMiB: 3 * 1024, vcpu: 1 } });

  await coordinate({ action: "registerHost", hostId: "i-fleet", shape: LARGE, ready: true, provenance: "launched" });
  const reused = await coordinate({
    action: "placeSession",
    sessionId: "s1",
    worldId: "made-later",
    serverId: "factorio",
    eligibleProvenance: "launched",
  });
  assert.deepEqual(reused.placement, { kind: "reuse", hostId: "i-fleet", slot: 0 });

  const bound = await coordinate({
    action: "placeSession",
    sessionId: "s2",
    worldId: "world",
    eligibleProvenance: "launched",
  });
  assert.deepEqual(bound.placement, { kind: "refused", reason: "bound_to_configured_host" });
});

test("a Zomboid world and a public world take slot zero only; the second of them on a host asks for a launch", async () => {
  const fleet = new MemoryFleet();
  const coordinate = coordinator(fleet);
  await coordinate({ action: "registerHost", hostId: "i-1", shape: LARGE, ready: true });
  const pz = await coordinate({ action: "placeSession", sessionId: "s1", worldId: "knox", serverId: "zomboid" });
  assert.deepEqual(pz.placement, { kind: "reuse", hostId: "i-1", slot: 0 });
  const factorio = await coordinate({ action: "placeSession", sessionId: "s2", worldId: "base", serverId: "factorio" });
  assert.deepEqual(factorio.placement, { kind: "reuse", hostId: "i-1", slot: 1 }, "a slottable game takes the next slot beside it");
  const secondPz = await coordinate({ action: "placeSession", sessionId: "s3", worldId: "louisville", serverId: "zomboid" });
  assert.equal(secondPz.placement?.kind, "launch", "slot zero is taken, so the second Zomboid needs a host of its own");

  const publicCatalogWorld = { id: "arena", displayName: "Arena", profileId: "p", sessionControl: "v1" as const, connectivity: "raw" as const };
  const { worldNeedsSlotZero } = await import("../src/control-plane/catalog.ts");
  assert.equal(worldNeedsSlotZero("arena", undefined, [{ id: "minecraft", code: "MC", displayName: "Minecraft", connectPort: 25565, worlds: [publicCatalogWorld] }]), true);
  assert.equal(worldNeedsSlotZero("world"), false);
  assert.equal(worldNeedsSlotZero("knox", "zomboid"), true);
  assert.equal(worldNeedsSlotZero("base", "factorio"), false);
});
