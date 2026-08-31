import assert from "node:assert/strict";
import test from "node:test";

import { initialLifecycleRecord } from "../src/domain/lifecycle.ts";
import { readControlPlaneSnapshot, type ControlPlaneSources } from "../src/control-plane/read-model.ts";
import { gameCatalog } from "../src/control-plane/catalog.ts";

const sources: ControlPlaneSources = {
  listHosts: async () => [
    { id: "host-a", name: "Host A", state: "stopped", providerRef: "i-secret", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1a", launchedAt: "2026-08-01T00:00:00.000Z" },
    { id: "host-b", name: "Host B", state: "running", providerRef: "i-secret-2", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1b", launchedAt: "2026-08-02T00:00:00.000Z" },
  ],
  readLifecycle: async (serverId) => serverId === "minecraft" ? initialLifecycleRecord("minecraft", 100) : null,
  readReleasePointer: async (worldId) => worldId === "world"
    ? { state: "available", desiredRelease: "1.1", activeRelease: "1.0" }
    : { state: "unconfigured", desiredRelease: null, activeRelease: null },
  listRunningOperations: async () => [{ id: "start-1", type: "start", status: "running", startedAt: "2026-08-29T00:00:00.000Z", providerRef: "arn:execution" }],
};

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

test("each world's address carries its own game's port, and only for callers allowed one", async () => {
  const sources: ControlPlaneSources = {
    listHosts: async () => [],
    listRunningOperations: async () => [],
    readLifecycle: async () => null,
    readReleasePointer: async () => ({ state: "unconfigured", desiredRelease: null, activeRelease: null }),
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
  assert.equal(addresses.get("factorio"), "172.29.23.24:34197");
  assert.equal(addresses.get("zomboid"), "172.29.23.24:16261");

  // One configured string used to answer 25565 for every game. It cannot now.
  assert.equal(new Set(addresses.values()).size, 3);

  const withheld = await readControlPlaneSnapshot(sources, {
    includeInfrastructure: false,
    includeDesiredRelease: false,
  });
  for (const game of withheld.games) {
    for (const world of game.worlds) assert.equal(world.connectionAddress, null);
  }
});
