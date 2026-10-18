import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SFNClient } from "@aws-sdk/client-sfn";
import { initialLifecycleRecord, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { type ControlPlaneSources, type HostObservation } from "../src/control-plane/read-model.ts";
import { type WorldRecord } from "../src/control-plane/world-registry.ts";
import { controlSession, controlWorldLifecycle, createWorld, updateWorldSettings } from "../src/handlers/api/worlds.ts";

process.env.OPERATION_STATE_MACHINES = JSON.stringify(["start", "stop", "world"].map((type) => ({ type, arn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${type}` })));
process.env.SPAWNPOINT_PLACEMENT = "single";
process.env.SPAWNPOINT_LAUNCH = "enabled";

const identity = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;
const record: WorldRecord = {
  gameId: "minecraft", worldId: "test-world", displayName: "Test world", status: "active", placement: "configured", connectivity: "zerotier",
  preset: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: `gen-${"c".repeat(32)}`, release: "1.2", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};

function running(serverId = "minecraft"): LifecycleRecord {
  return { ...initialLifecycleRecord(serverId, 1), activeWorldId: record.worldId, activeSessionId: "session-test", desiredState: "running", observedState: "ready" };
}

function scenario(t: TestContext, options: Readonly<{
  world?: WorldRecord; state?: HostObservation["state"]; game?: LifecycleRecord | null; own?: LifecycleRecord | null;
}> = {}) {
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  const inputs: Record<string, unknown>[] = [];
  t.mock.method(sources, "listHosts", async () => [{
    id: "host", name: "Host", state: options.state ?? "stopped", providerRef: "i-12345678", instanceType: null,
    availabilityZone: null, launchedAt: null, publicIp: null, provenance: "configured" as const,
  }]);
  t.mock.method(sources, "listPresets", async () => []);
  t.mock.method(sources, "listRunningOperations", async () => []);
  t.mock.method(sources, "listWorldRecords", async () => [options.world ?? record]);
  t.mock.method(sources, "readLifecycle", async (key: string) => key.startsWith("world#") ? options.own ?? null : options.game ?? null);
  t.mock.method(sources, "readReleaseManifest", async () => ({}));
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    const input = (command as { input: { input: string } }).input;
    inputs.push(JSON.parse(input.input) as Record<string, unknown>);
    return { executionArn: "arn:aws:states:eu-central-1:123456789012:execution:test:operation" };
  });
  return inputs;
}

test("configured start uses the planned host and the game's session key", async (t) => {
  const inputs = scenario(t);
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.worldId, record.worldId);
  assert.equal(inputs[0]?.serverId, "minecraft");
  assert.equal(inputs[0]?.instanceId, "i-12345678");
});

test("stop preserves the active session; already-stopped worlds dispatch nothing", async (t) => {
  const inputs = scenario(t, { state: "running", game: running() });
  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(inputs[0]?.sessionId, "session-test");
});

test("an already-stopped world returns a noop without creating a workflow", async (t) => {
  const inputs = scenario(t);
  const result = await controlSession(identity, "stop", record.gameId, record.worldId);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { result: "already_stopped" });
  assert.deepEqual(inputs, []);
});

test("stopped-host recovery still dispatches stop for the recorded stopping session", async (t) => {
  const inputs = scenario(t, { game: { ...running(), desiredState: "stopped", observedState: "stopping" } });
  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(inputs[0]?.sessionId, "session-test");
});

test("fleet starts retain their own lifecycle key instead of the configured game's key", async (t) => {
  const inputs = scenario(t, { world: { ...record, placement: "fleet", connectivity: "raw", auth: "game" } });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(inputs[0]?.serverId, `world#${record.worldId}`);
});

test("unsafe lifecycle inputs are rejected before any workflow can be dispatched", async (t) => {
  const inputs = scenario(t);
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "restore", record.gameId, record.worldId, JSON.stringify({ backupKey: "worlds/other/archives/save.tar.zst" }))).body), { error: "invalid_backup_key" });
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "purge", record.gameId, record.worldId, "{}")).body), { error: "invalid_purge_confirmation" });
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "regenerate", record.gameId, record.worldId, JSON.stringify({ release: "../1.2" }))).body), { error: "invalid_release" });
  assert.equal((await controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "null")).statusCode, 400);
  assert.deepEqual(inputs, []);
});

test("archiving a running world stops only its tracked active session", async (t) => {
  const inputs = scenario(t, { state: "running", game: running() });
  assert.equal((await controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "{}")).statusCode, 202);
  assert.equal(inputs[0]?.sessionId, "session-test");
  assert.equal(inputs[0]?.stopRequired, true);
  assert.equal(inputs[0]?.targetGenerationId, record.currentGeneration.id);
});

test("archiving refuses a configured host's untracked session", async (t) => {
  const inputs = scenario(t, { state: "running" });
  const result = await controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "{}");
  assert.equal(result.statusCode, 409);
  assert.deepEqual(JSON.parse(result.body), { error: "active_session_unavailable" });
  assert.deepEqual(inputs, []);
});

test("restore verifies the saved generation's release before requesting a workflow", async (t) => {
  const inputs = scenario(t);
  const key = `worlds/${record.worldId}/archives/save-${record.currentGeneration.id}-test.tar.zst`;
  assert.equal((await controlWorldLifecycle(identity, "restore", record.gameId, record.worldId, JSON.stringify({ backupKey: key }))).statusCode, 202);
  assert.equal(inputs[0]?.backupKey, key);
  assert.equal(inputs[0]?.stopRequired, false);
});

test("purge still requires an archived world even with the exact confirmation", async (t) => {
  const inputs = scenario(t);
  const result = await controlWorldLifecycle(identity, "purge", record.gameId, record.worldId, JSON.stringify({ confirmation: record.worldId }));
  assert.deepEqual(JSON.parse(result.body), { error: "world_not_archived" });
  assert.deepEqual(inputs, []);
});

test("world connectivity validation keeps its creation defaults and explicit-update rules", async (t) => {
  scenario(t);
  const create = await createWorld(identity, "minecraft", "unknown", JSON.stringify({ displayName: "Test", release: "1.2" }));
  assert.deepEqual(JSON.parse(create.body), { error: "unknown_preset" });
  const missing = await updateWorldSettings("minecraft", record.worldId, "{}");
  assert.deepEqual(JSON.parse(missing.body), { error: "invalid_world_connectivity" });
  const invalid = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ placement: "configured", connectivity: "raw", auth: "game" }));
  assert.deepEqual(JSON.parse(invalid.body), { error: "invalid_world_connectivity" });
});
