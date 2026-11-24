import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { ControlPlaneSources } from "../src/control-plane/read-model.ts";
import type { SessionMachines } from "../src/control-plane/session-machines.ts";
import type { WorldChange, WorldRecords } from "../src/control-plane/world-records.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { worldsFeature } from "../src/handlers/api/worlds.ts";

// The world operations against their ports: what reaches the record store and
// the machines, with no cloud API behind them.

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const unused = new Proxy({}, { get: () => { throw new Error("not expected in this test"); } });

function fakes(change: WorldChange, record: WorldRecord | null = null) {
  const replaced: unknown[] = [];
  const worlds = {
    ...unused,
    read: async () => record,
    replaceGameSettings: async (_game: string, _world: string, settings: unknown) => { replaced.push(settings); return change; },
  } as unknown as WorldRecords;
  const feature = worldsFeature({
    sources: unused as ControlPlaneSources,
    worlds,
    machines: unused as SessionMachines,
    gateway: unused as never,
    backupReleases: () => unused as never,
  });
  return { feature, replaced };
}

const settings = (values: Record<string, unknown>) => JSON.stringify({ values });

test("valid game settings reach the record store with who set them", async () => {
  const { feature, replaced } = fakes("updated");
  const response = await feature.updateGameSettings(owner, "valheim", "world-a", settings({}));
  assert.equal(response.statusCode, 200);
  assert.equal(replaced.length, 1);
  assert.deepEqual((replaced[0] as { updatedBy: unknown }).updatedBy, { identityId: "identity-1", displayName: "Owner" });
});

test("the record store's answer becomes the refusal", async () => {
  for (const [change, status, error] of [["missing", 404, "unknown_world"], ["archived", 409, "world_archived"], ["conflict", 409, "world_settings_conflict"]] as const) {
    const response = await fakes(change).feature.updateGameSettings(owner, "valheim", "world-a", settings({}));
    assert.deepEqual([response.statusCode, JSON.parse(response.body).error], [status, error]);
  }
});

test("a game with no settings stores nothing", async () => {
  const { feature, replaced } = fakes("updated");
  assert.equal((await feature.updateGameSettings(owner, "factorio", "world-a", settings({}))).statusCode, 409);
  assert.deepEqual(replaced, []);
});

test("a game that keeps no whitelist reads no record", async () => {
  const { feature } = fakes("updated");
  assert.equal((await feature.whitelistOf("factorio", "world-a")).statusCode, 409);
});
