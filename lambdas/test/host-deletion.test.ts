import assert from "node:assert/strict";
import test from "node:test";

import { hostDeletionRefusal, type HostDeletionRun } from "../src/control-plane/host-deletion.ts";
import type { ControlPlaneSources, HostObservation } from "../src/control-plane/read-model.ts";
import { hostsFeature } from "../src/handlers/api/hosts.ts";
import { recordsFor, configuredCatalog } from "./support/configured-worlds.ts";
import type { Identity } from "../src/access/domain.ts";

// ADR-0100: a persistent host is deleted from the panel once every world has left it.

const persistent: HostObservation = {
  id: "spawnpoint-game-host", name: "spawnpoint-game-host", state: "stopped", providerRef: "i-09c9b5069308ac372",
  instanceType: "m7i-flex.large", availabilityZone: "eu-central-1b", launchedAt: null, publicIp: null, provenance: "configured",
};
const launched: HostObservation = { ...persistent, id: "fleet-1", name: "fleet-1", providerRef: "i-0aaaaaaaaaaaaaaaa", provenance: "launched" };
const configuredWorlds = recordsFor(configuredCatalog);
const fleetWorlds = configuredWorlds.map((record) => ({ ...record, placement: "fleet" as const, connectivity: "route53" as const, auth: "game" as const }));

test("a persistent host may be deleted only when stopped, with no world placed on it and nothing running", () => {
  assert.equal(hostDeletionRefusal(persistent.providerRef, [persistent], fleetWorlds, []), null);
  assert.equal(hostDeletionRefusal("i-0123456789abcdef0", [persistent], fleetWorlds, []), "unknown_host");
  assert.equal(hostDeletionRefusal(launched.providerRef, [launched], fleetWorlds, []), "host_is_launched", "the fleet lets its own hosts go");
  assert.equal(hostDeletionRefusal(persistent.providerRef, [{ ...persistent, state: "running" }], fleetWorlds, []), "host_not_stopped");
  assert.equal(hostDeletionRefusal(persistent.providerRef, [persistent], configuredWorlds, []), "host_in_use");
  const archived = configuredWorlds.map((record) => ({ ...record, status: "archived" as const }));
  assert.equal(hostDeletionRefusal(persistent.providerRef, [persistent], archived, []), null, "an archived world keeps its save in S3, not on the host");
  const running = [{ id: "op", type: "start" as const, status: "running" as const, startedAt: "2026-11-25T00:00:00.000Z", providerRef: "arn", worldId: null }];
  assert.equal(hostDeletionRefusal(persistent.providerRef, [persistent], fleetWorlds, running), "operation_in_progress");
});

const owner = { id: "identity-owner" } as Identity;

function feature(name: string | null = "spawnpoint-game-host") {
  const started: HostDeletionRun[] = [];
  const sources = {
    listHosts: async () => [persistent, launched],
    listWorldRecords: async () => fleetWorlds,
    listRunningOperations: async () => [],
  } as unknown as ControlPlaneSources;
  const hosts = hostsFeature({
    sources,
    deletion: {
      readDisks: async () => ({ name, dataVolumeIds: ["vol-01bcd86ae27b55682"] }),
      start: async (run) => { started.push(run); return "arn:execution"; },
    },
  });
  return { hosts, started };
}

test("the API starts the delete machine with the host's data volumes and the owner's snapshot choice", async () => {
  const { hosts, started } = feature();
  const answer = await hosts.deleteHost(owner, persistent.providerRef, JSON.stringify({ snapshot: true }));
  assert.equal(answer.statusCode, 202);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]?.dataVolumeIds, ["vol-01bcd86ae27b55682"]);
  assert.equal(started[0]?.snapshot, true);
  assert.equal(started[0]?.requestedBy, "identity:identity-owner");
});

test("the choice is asked each time, and only Spawnpoint's own host is deleted", async () => {
  const { hosts, started } = feature();
  assert.equal((await hosts.deleteHost(owner, persistent.providerRef, "{}")).statusCode, 400, "no default for the snapshot");
  assert.equal((await hosts.deleteHost(owner, "not-an-instance", JSON.stringify({ snapshot: false }))).statusCode, 400);
  assert.equal((await hosts.deleteHost(owner, launched.providerRef, JSON.stringify({ snapshot: false }))).statusCode, 409);
  const stranger = feature("someone-elses-instance");
  assert.equal((await stranger.hosts.deleteHost(owner, persistent.providerRef, JSON.stringify({ snapshot: false }))).statusCode, 409);
  assert.equal(started.length + stranger.started.length, 0);
});
