import assert from "node:assert/strict";
import test from "node:test";

import { initialLifecycleRecord } from "../src/domain/lifecycle.ts";
import { readControlPlaneSnapshot, type ControlPlaneSources } from "../src/control-plane/read-model.ts";

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
