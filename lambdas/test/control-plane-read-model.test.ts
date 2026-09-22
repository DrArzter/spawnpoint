import assert from "node:assert/strict";
import test from "node:test";

import { initialLifecycleRecord } from "../src/domain/lifecycle.ts";
import { readControlPlaneSnapshot, type ControlPlaneSources } from "../src/control-plane/read-model.ts";
import { gameCatalog } from "../src/control-plane/catalog.ts";

const sources: ControlPlaneSources = {
  listHosts: async () => [
    { id: "host-a", name: "Host A", state: "stopped", providerRef: "i-secret", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1a", launchedAt: "2026-08-01T00:00:00.000Z", publicIp: null },
    { id: "host-b", name: "Host B", state: "running", providerRef: "i-secret-2", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1b", launchedAt: "2026-08-02T00:00:00.000Z", publicIp: "203.0.113.10" },
  ],
  readLifecycle: async (serverId) => serverId === "minecraft" ? initialLifecycleRecord("minecraft", 100) : null,
  readReleasePointer: async (worldId) => worldId === "world"
    ? { state: "available", generationId: null, desiredRelease: "1.1", activeRelease: "1.0" }
    : { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null },
  listRunningOperations: async () => [{ id: "start-1", type: "start", status: "running", startedAt: "2026-08-29T00:00:00.000Z", providerRef: "arn:execution" }],
};

test("retains the supplied projection observation timestamp", async () => {
  const observedAt = new Date("2026-08-29T00:58:00.000Z");
  const snapshot = await readControlPlaneSnapshot(
    { ...sources, readObservedAt: async () => observedAt },
    { includeInfrastructure: true, includeDesiredRelease: true },
    undefined,
    () => new Date("2026-08-29T01:00:00.000Z"),
  );

  assert.equal(snapshot.observedAt, observedAt.toISOString());
});

test("builds a multi-host read model without binding stopped worlds to instances", async () => {
  const snapshot = await readControlPlaneSnapshot(sources, { includeInfrastructure: true, includeDesiredRelease: true }, undefined, () => new Date("2026-08-29T01:00:00.000Z"));
  assert.equal(snapshot.hosts.length, 2);
  assert.equal(snapshot.games[0]?.worlds[0]?.release.activeRelease, "1.0");
  assert.equal(snapshot.games[0]?.worlds[0]?.release.desiredRelease, "1.1");
  assert.equal(snapshot.games[1]?.lifecycle, null);
  assert.equal(snapshot.operations[0]?.providerRef, "arn:execution");
});

test("redacts infrastructure references and desired releases from coarse status", async () => {
  const snapshot = await readControlPlaneSnapshot(sources, { includeInfrastructure: false, includeDesiredRelease: false });
  assert.equal("providerRef" in snapshot.hosts[0]!, false);
  assert.equal("instanceType" in snapshot.hosts[0]!, false);
  assert.equal("providerRef" in snapshot.operations[0]!, false);
  assert.equal(snapshot.games[0]?.worlds[0]?.release.activeRelease, "1.0");
  assert.equal(snapshot.games[0]?.worlds[0]?.release.desiredRelease, null);
});

test("the panel's catalog offers exactly the worlds the host catalog resolves", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../../server/worlds/catalog.json", import.meta.url);
  const hostCatalog = JSON.parse(await readFile(url, "utf8")) as {
    worlds: ReadonlyArray<{ id: string; game?: string }>;
  };

  const hostPairs = new Set(hostCatalog.worlds.map((world) => `${world.game ?? "minecraft"}/${world.id}`));
  const panelPairs = new Set(gameCatalog.flatMap((game) => game.worlds.map((world) => `${game.id}/${world.id}`)));

  // Two lists of the same worlds is a duplication this project accepts for now,
  // deliberately: the panel is a Lambda and the host catalog is a file on a
  // volume. What it must not do is drift — a world the panel offers and the host
  // cannot resolve fails at the session command, after the instance is running.
  assert.deepEqual([...panelPairs].sort(), [...hostPairs].sort());
});

test("a footprint the host catalog states is the one the panel places with", async () => {
  const { readFile } = await import("node:fs/promises");
  const { footprintForWorld } = await import("../src/control-plane/catalog.ts");
  const url = new URL("../../server/worlds/catalog.json", import.meta.url);
  const hostCatalog = JSON.parse(await readFile(url, "utf8")) as {
    worlds: ReadonlyArray<{ id: string; footprint?: { memory_mib: number; cores: number } }>;
  };
  // The host reads its own file and the panel its own module; a session limited
  // to one figure and placed by another would fit on paper and be killed on the box.
  for (const world of hostCatalog.worlds) {
    if (!world.footprint) continue;
    assert.deepEqual(footprintForWorld(world.id), { memoryMiB: world.footprint.memory_mib, cores: world.footprint.cores }, world.id);
  }
});

test("each world's address carries its own game's port, and only for callers allowed one", async () => {
  const sources: ControlPlaneSources = {
    listHosts: async () => [],
    listRunningOperations: async () => [],
    readLifecycle: async () => null,
    readReleasePointer: async () => ({ state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null }),
    listPresets: async () => [
      {
        id: "factorio-vanilla", displayName: "Factorio vanilla", gameId: "factorio",
        repository: "https://github.com/example/factorio", commit: "1".repeat(40), profileDigest: "2".repeat(64),
        buildStatus: "ready", releases: ["1.0"], latestRelease: "1.0",
      },
      {
        id: "zomboid-vanilla", displayName: "Project Zomboid vanilla", gameId: "zomboid",
        repository: "https://github.com/example/zomboid", commit: "3".repeat(40), profileDigest: "4".repeat(64),
        buildStatus: "ready", releases: ["1.0"], latestRelease: "1.0",
      },
    ],
  };

  const visible = await readControlPlaneSnapshot(sources, {
    includeInfrastructure: false,
    includeDesiredRelease: false,
    connectionHost: "172.29.23.24",
  });
  const addresses = new Map(
    visible.games.flatMap((game) => game.worlds.map((world) => [world.id, world.connectionAddress])),
  );
  assert.equal(addresses.get("world"), "172.29.23.24:25565");
  assert.equal(addresses.has("factorio-vanilla"), false, "a reusable preset is not a world until one is created");
  assert.equal(addresses.has("zomboid-vanilla"), false, "a reusable preset is not a world until one is created");
  assert.equal(visible.games.find((game) => game.id === "factorio")?.presets[0]?.id, "factorio-vanilla");
  assert.equal(visible.games.find((game) => game.id === "zomboid")?.presets[0]?.id, "zomboid-vanilla");

  const withheld = await readControlPlaneSnapshot(sources, {
    includeInfrastructure: false,
    includeDesiredRelease: false,
  });
  for (const game of withheld.games) {
    for (const world of game.worlds) assert.equal(world.connectionAddress, null);
  }
});

test("a public world's address is the instance's current one, and nothing while it is stopped", async () => {
  const publicCatalog = [{
    id: "minecraft",
    code: "MC",
    displayName: "Minecraft",
    connectPort: 25565,
    worlds: [
      { id: "world", displayName: "Main modded", profileId: "main", sessionControl: "v1" as const, connectivity: "raw" as const },
      { id: "vanilla", displayName: "Vanilla Forge", profileId: "vanilla-forge", sessionControl: "v1" as const, connectivity: "zerotier" as const },
    ],
  }];
  const withHosts = (hosts: Awaited<ReturnType<ControlPlaneSources["listHosts"]>>): ControlPlaneSources => ({
    listHosts: async () => hosts,
    listRunningOperations: async () => [],
    readLifecycle: async () => null,
    readReleasePointer: async () => ({ state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null }),
  });
  const options = { includeInfrastructure: false, includeDesiredRelease: false, connectionHost: "172.29.23.24" };

  const running = await readControlPlaneSnapshot(
    withHosts([{ id: "h", name: "Host", state: "running", providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null, publicIp: "203.0.113.10" }]),
    options,
    publicCatalog,
  );
  const addresses = new Map(running.games[0]!.worlds.map((world) => [world.id, world.connectionAddress]));
  assert.equal(addresses.get("world"), "203.0.113.10:25565", "a public world publishes the address the instance holds");
  assert.equal(addresses.get("vanilla"), "172.29.23.24:25565", "an overlay world beside it is unaffected");

  const stopped = await readControlPlaneSnapshot(
    withHosts([{ id: "h", name: "Host", state: "stopped", providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null, publicIp: null }]),
    options,
    publicCatalog,
  );
  const whenStopped = new Map(stopped.games[0]!.worlds.map((world) => [world.id, world.connectionAddress]));
  assert.equal(whenStopped.get("world"), null, "an ephemeral address does not exist between sessions, so none is shown");
  assert.equal(whenStopped.get("vanilla"), "172.29.23.24:25565", "the overlay address is stable and still shown");
});

test("a fleet world never borrows another running host's public address", async () => {
  const fleetCatalog = [{
    id: "factorio", code: "FA", displayName: "Factorio", connectPort: 34197,
    worlds: [{ id: "factory", displayName: "Factory", profileId: "vanilla", sessionControl: "v1" as const, connectivity: "raw" as const, placement: "fleet" as const }],
  }];
  const snapshot = await readControlPlaneSnapshot({
    listHosts: async () => [{ id: "configured", name: "Persistent host", state: "running", providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null, publicIp: "203.0.113.10", provenance: "configured" }],
    listRunningOperations: async () => [],
    readLifecycle: async () => null,
    readReleasePointer: async () => ({ state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null }),
  }, { includeInfrastructure: false, includeDesiredRelease: false, connectionHost: "172.29.23.24" }, fleetCatalog);
  assert.equal(snapshot.games[0]?.worlds[0]?.connectionAddress, null);
});

test("a ready session's address is the one the host reported, port and all; a stopped world's is composed", async () => {
  const { acquireLease, beginSession, markSessionReady } = await import("../src/domain/lifecycle.ts");
  const acquired = acquireLease(initialLifecycleRecord("minecraft", 100), "op", 100, 300);
  const ready = markSessionReady(beginSession(acquired.record, acquired.ownership, "s1", "vanilla", 101), acquired.ownership, "s1", 102, "172.29.23.24:30010");
  const snapshot = await readControlPlaneSnapshot(
    { ...sources, readLifecycle: async (serverId) => serverId === "minecraft" ? ready : null },
    { includeInfrastructure: false, includeDesiredRelease: false, connectionHost: "172.29.23.24" },
  );
  const addresses = new Map(snapshot.games[0]!.worlds.map((world) => [world.id, world.connectionAddress]));
  assert.equal(addresses.get("vanilla"), "172.29.23.24:30010", "the session on slot one publishes its slot's port");
  assert.equal(addresses.get("world"), "172.29.23.24:25565", "a world with no session shows where it would be");
  const withheld = await readControlPlaneSnapshot(
    { ...sources, readLifecycle: async (serverId) => serverId === "minecraft" ? ready : null },
    { includeInfrastructure: false, includeDesiredRelease: false },
  );
  assert.equal(withheld.games[0]!.worlds.find((world) => world.id === "vanilla")?.connectionAddress, null, "a caller who may not read an address reads none, observed or not");
});
