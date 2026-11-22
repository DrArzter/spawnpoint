import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import { initialLifecycleRecord, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { planPromotion, type PromotionFacts } from "../src/control-plane/promotion.ts";
import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import type { ControlPlaneSources, OperationObservation } from "../src/control-plane/read-model.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { promoteWorld } from "../src/handlers/api/promotion.ts";

process.env.OPERATION_STATE_MACHINES = JSON.stringify(["start", "stop", "promote", "world"].map((type) => ({ type, arn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${type}` })));

const GENERATION = `gen-${"c".repeat(32)}`;
const record: WorldRecord = {
  gameId: "minecraft", worldId: "prominence-a1b2c3d4", displayName: "Prominence", status: "active", placement: "fleet",
  connectivity: "raw", auth: "game",
  preset: { id: "prominence", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: GENERATION, release: "100.1", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};
const preset: PresetObservation = {
  id: "prominence", displayName: "Prominence II", gameId: "minecraft", repository: record.preset.repository,
  commit: record.preset.commit, profileDigest: record.preset.profileDigest,
  releases: ["100.1", "200.1"], latestRelease: "200.1", buildStatus: "ready",
};

function facts(values: Partial<PromotionFacts> = {}): PromotionFacts {
  return {
    gameId: "minecraft", release: "200.1", record, preset,
    pointer: { state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: "100.1" },
    releaseUsability: "usable",
    session: null, blockingOperations: 0, launchEnabled: true, configuredHostId: "i-0123456789abcdef0",
    ...values,
  };
}

function refused(values: Partial<PromotionFacts>): string {
  const plan = planPromotion(facts(values));
  return plan.kind === "reject" ? `${plan.status} ${plan.error}` : "execute";
}

test("a fleet world is promoted to another ready release of its own preset", () => {
  assert.deepEqual(planPromotion(facts()), {
    kind: "execute", record, release: "200.1", previous: "100.1", instanceId: "i-0123456789abcdef0",
  });
});

test("the body must name one release", () => {
  assert.equal(refused({ release: undefined }), "400 invalid_release");
  assert.equal(refused({ release: "latest" }), "400 invalid_release");
});

test("only an active fleet world of this game is promoted here", () => {
  assert.equal(refused({ record: undefined }), "404 unknown_world");
  assert.equal(refused({ gameId: "factorio" }), "404 unknown_world");
  assert.equal(refused({ record: { ...record, status: "archived" } }), "409 world_archived");
  assert.equal(refused({ record: { ...record, placement: "configured", connectivity: "zerotier" } }), "409 promotion_needs_fleet_world");
  assert.equal(refused({ launchEnabled: false }), "409 fleet_unavailable");
});

test("the release belongs to the world's own preset, and that preset is built", () => {
  assert.equal(refused({ preset: undefined }), "409 preset_removed");
  assert.equal(refused({ preset: { ...preset, id: "other" } }), "409 preset_removed");
  assert.equal(refused({ release: "300.1" }), "409 release_not_available");
  assert.equal(refused({ preset: { ...preset, buildStatus: "building" } }), "409 release_not_available");
});

test("a release being retired, retired or not yet built is not promoted to", () => {
  assert.equal(refused({ releaseUsability: "release_retired" }), "409 release_retired");
  assert.equal(refused({ releaseUsability: "release_not_ready" }), "409 release_not_ready");
});

test("the API asks the reference table about the release before it plans", async (t) => {
  const { inputs } = scenario(t);
  t.mock.method(awsControlPlaneSources as Required<ControlPlaneSources>, "readReleaseState", async () => "retiring");
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.equal(result.statusCode, 409);
  assert.deepEqual(JSON.parse(result.body), { error: "release_retired" });
  assert.deepEqual(inputs, []);
});

test("the wipe's pointer must be readable, have run a release, and not run this one already", () => {
  assert.equal(refused({ pointer: { state: "unavailable", generationId: GENERATION, desiredRelease: null, activeRelease: null } }), "409 release_state_unavailable");
  assert.equal(refused({ pointer: { state: "available", generationId: `gen-${"d".repeat(32)}`, desiredRelease: "100.1", activeRelease: "100.1" } }), "409 release_state_unavailable");
  assert.equal(refused({ pointer: { state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: null } }), "409 no_active_release");
  assert.equal(refused({ release: "100.1" }), "409 release_already_active");
});

test("a promotion only moves forward along the preset's releases; going back is a restore", () => {
  const onNewer = { state: "available", generationId: GENERATION, desiredRelease: "200.1", activeRelease: "200.1" } as const;
  assert.equal(refused({ pointer: onNewer, release: "100.1" }), "409 release_older_than_active");
  const unlisted = { state: "available", generationId: GENERATION, desiredRelease: "050.1", activeRelease: "050.1" } as const;
  assert.notEqual(refused({ pointer: unlisted, release: "100.1" }), "409 release_older_than_active");
});

test("players online, another operation, or no fallback host refuse before the workflow starts", () => {
  const playing: LifecycleRecord = { ...initialLifecycleRecord("world#prominence-a1b2c3d4", 1), idle: { playersOnline: 2 } as LifecycleRecord["idle"] };
  assert.equal(refused({ session: playing }), "409 players_online");
  assert.equal(refused({ blockingOperations: 1 }), "409 operation_in_progress");
  assert.equal(refused({ configuredHostId: undefined }), "409 configured_host_unavailable");
});

function scenario(t: TestContext, options: Readonly<{ operations?: OperationObservation[]; world?: WorldRecord }> = {}) {
  process.env.SPAWNPOINT_LAUNCH = "enabled";
  process.env.RELEASE_BUCKET = "releases";
  t.after(() => { delete process.env.SPAWNPOINT_LAUNCH; delete process.env.RELEASE_BUCKET; });
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  t.mock.method(sources, "listHosts", async () => [{ id: "configured", providerRef: "i-0123456789abcdef0", state: "stopped", provenance: "configured" }]);
  t.mock.method(sources, "listPresets", async () => [preset]);
  t.mock.method(sources, "readReleaseState", async () => null);
  t.mock.method(sources, "listRunningOperations", async () => options.operations ?? []);
  t.mock.method(sources, "listWorldRecords", async () => [options.world ?? { ...record, warm: true }]);
  t.mock.method(sources, "readReleasePointer", async () => ({ state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: "100.1" }));
  const lifecycleKeys: string[] = [];
  t.mock.method(sources, "readLifecycle", async (key: string) => { lifecycleKeys.push(key); return null; });
  const inputs: Array<Record<string, unknown>> = [];
  const machines: string[] = [];
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    assert.ok(command instanceof StartExecutionCommand);
    machines.push(String(command.input.stateMachineArn));
    inputs.push(JSON.parse(String(command.input.input)) as Record<string, unknown>);
    return { executionArn: "arn:aws:states:eu-central-1:123456789012:execution:promote:test" };
  });
  return { inputs, machines, lifecycleKeys };
}

const owner = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

test("the API starts the promote machine with the fleet world's own record, placement and warm choice", async (t) => {
  const { inputs, machines, lifecycleKeys } = scenario(t);
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.equal(result.statusCode, 202);
  assert.deepEqual({ ...JSON.parse(result.body), operationId: undefined }, { result: "requested", release: "200.1", previousRelease: "100.1", operationId: undefined });
  assert.deepEqual(machines, ["arn:aws:states:eu-central-1:123456789012:stateMachine:promote"]);
  assert.deepEqual(lifecycleKeys, [`world#${record.worldId}`]);
  const input = inputs[0]!;
  assert.equal(input.serverId, `world#${record.worldId}`);
  assert.equal(input.placement, "fleet");
  assert.equal(input.policy, "warm");
  assert.equal(input.launch, "enabled");
  assert.equal(input.generationId, GENERATION);
  assert.equal(input.presetId, "prominence");
  assert.equal(input.release, "200.1");
  assert.equal(input.releaseBucket, "releases");
  assert.equal(input.requestedBy, "identity:owner");
});

test("a refused promotion starts nothing", async (t) => {
  const { inputs } = scenario(t, { operations: [{ id: "op", type: "start", worldId: record.worldId } as OperationObservation] });
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.equal(result.statusCode, 409);
  assert.deepEqual(JSON.parse(result.body), { error: "operation_in_progress" });
  assert.equal((await promoteWorld(owner, "minecraft", record.worldId, "{not json")).statusCode, 400);
  assert.deepEqual(inputs, []);
});
