import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

import { initialLifecycleRecord, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { planPromotion, type PromotionFacts, type PromotionPlan } from "../src/control-plane/promotion.ts";
import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import type { ControlPlaneSources, OperationObservation } from "../src/control-plane/read-model.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { InvalidBodyError } from "../src/handlers/api/http.ts";
import { deployedPromotion } from "../src/handlers/api/promotion-wiring.ts";

const { promoteWorld } = deployedPromotion;

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
    releaseUsability: "usable", hasBackup: false,
    session: null, blockingOperations: 0, launchEnabled: true,
    ...values,
  };
}

function refused(values: Partial<PromotionFacts>): string {
  const plan = planPromotion(facts(values));
  return plan.kind === "reject" ? `${plan.status} ${plan.error}` : "execute";
}

test("a fleet world is promoted to another ready release of its own preset", () => {
  assert.deepEqual(planPromotion(facts()), {
    kind: "execute", record, release: "200.1", previous: "100.1",
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

test("the wipe's pointer must be readable and not run this release already", () => {
  assert.equal(refused({ pointer: { state: "unavailable", generationId: GENERATION, desiredRelease: null, activeRelease: null } }), "409 release_state_unavailable");
  assert.equal(refused({ pointer: { state: "available", generationId: `gen-${"d".repeat(32)}`, desiredRelease: "100.1", activeRelease: "100.1" } }), "409 release_state_unavailable");
  assert.equal(refused({ release: "100.1" }), "409 release_already_active");
});

test("a promotion only moves forward along the preset's releases; going back is a restore", () => {
  const onNewer = { state: "available", generationId: GENERATION, desiredRelease: "200.1", activeRelease: "200.1" } as const;
  assert.equal(refused({ pointer: onNewer, release: "100.1" }), "409 release_older_than_active");
  const unlisted = { state: "available", generationId: GENERATION, desiredRelease: "050.1", activeRelease: "050.1" } as const;
  assert.notEqual(refused({ pointer: unlisted, release: "100.1" }), "409 release_older_than_active");
});

test("players online or another operation refuse before the workflow starts", () => {
  const playing: LifecycleRecord = { ...initialLifecycleRecord("world#prominence-a1b2c3d4", 1), idle: { playersOnline: 2 } as LifecycleRecord["idle"] };
  assert.equal(refused({ session: playing }), "409 players_online");
  assert.equal(refused({ blockingOperations: 1 }), "409 operation_in_progress");
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
  const backupChecks: string[] = [];
  t.mock.method(sources, "hasGenerationBackup", async (worldId: string, generationId: string) => { backupChecks.push(`${worldId}/${generationId}`); return false; });
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
  return { inputs, machines, lifecycleKeys, backupChecks };
}

const owner = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

test("a promotion of a game that has not run here is the Owner's alone (ADR-0109)", async (t) => {
  const { machines } = scenario(t);
  t.mock.method(awsControlPlaneSources as Required<ControlPlaneSources>, "listProvenGames", async () => new Set<string>());
  const promoter = { id: "promoter", displayName: "Promoter", roleId: "operator", directGrants: ["release.promote" as const] };
  const refused = await promoteWorld(promoter, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.deepEqual([refused.statusCode, JSON.parse(refused.body)], [403, { error: "game_not_proven" }]);
  assert.deepEqual(machines, []);
  assert.equal((await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }))).statusCode, 202);
});

test("the API starts the promote machine with the fleet world's own record, placement and warm choice", async (t) => {
  const { inputs, machines, lifecycleKeys } = scenario(t);
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.equal(result.statusCode, 202);
  assert.deepEqual({ ...JSON.parse(result.body), operationId: undefined }, { result: "requested", release: "200.1", previousRelease: "100.1", startAfter: true, operationId: undefined });
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
  await assert.rejects(promoteWorld(owner, "minecraft", record.worldId, "{not json"), InvalidBodyError);
  assert.deepEqual(inputs, []);
});

// A wipe that never started is switched, not promoted (ADR-0078).
const unstarted = { state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: null, runCount: 0 } as const;
const idle: LifecycleRecord = initialLifecycleRecord("world#prominence-a1b2c3d4", 1);

function unstartedFacts(values: Partial<PromotionFacts> = {}): PromotionFacts {
  return facts({ pointer: unstarted, ...values });
}

function unstartedPlan(values: Partial<PromotionFacts> = {}): string {
  const plan = planPromotion(unstartedFacts(values));
  return plan.kind === "reject" ? `${plan.status} ${plan.error}` : plan.kind;
}

test("a wipe that never started switches to a newer release, with no host needed", () => {
  assert.deepEqual(planPromotion(unstartedFacts()), { kind: "switch", record, release: "200.1", previous: "100.1" });
});

test("it also switches to an older release: there is no save to protect", () => {
  const onNewer = { ...unstarted, desiredRelease: "200.1" };
  const plan: PromotionPlan = planPromotion(unstartedFacts({ pointer: onNewer, release: "100.1", record: { ...record, currentGeneration: { ...record.currentGeneration, release: "200.1" } } }));
  assert.deepEqual(plan, { kind: "switch", record: { ...record, currentGeneration: { ...record.currentGeneration, release: "200.1" } }, release: "100.1", previous: "200.1" });
});

test("a world with an active release keeps the promotion rules", () => {
  assert.equal(refused({ hasBackup: true }), "execute");
  assert.equal(refused({ pointer: { state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: "100.1", runCount: 1 } }), "execute");
  assert.equal(refused({ release: "100.1" }), "409 release_already_active");
});

test("a wipe that ran, or that holds a backup, is not switched", () => {
  assert.equal(unstartedPlan({ pointer: { ...unstarted, runCount: 1 } }), "409 world_already_started");
  assert.equal(unstartedPlan({ hasBackup: true }), "409 world_already_started");
  const restored = { ...record, currentGeneration: { ...record.currentGeneration, source: { kind: "backup", key: "k", checksum: "c", generationId: "g" } } } as WorldRecord;
  assert.equal(unstartedPlan({ record: restored }), "409 world_already_started");
});

test("a session that starts or runs, or another operation, refuses the switch", () => {
  const running: LifecycleRecord = { ...idle, desiredState: "running", observedState: "starting", activeSessionId: "s" };
  assert.equal(unstartedPlan({ session: running }), "409 session_active");
  assert.equal(unstartedPlan({ session: { ...idle, observedState: "unknown" } }), "409 session_active");
  assert.equal(unstartedPlan({ session: idle }), "switch");
  assert.equal(unstartedPlan({ blockingOperations: 1 }), "409 operation_in_progress");
});

test("the switch refuses the release it names, one that is retired, and one of an older revision", () => {
  assert.equal(unstartedPlan({ release: "100.1" }), "409 release_already_selected");
  assert.equal(unstartedPlan({ releaseUsability: "release_retired" }), "409 release_retired");
  assert.equal(unstartedPlan({ releaseUsability: "release_not_ready" }), "409 release_not_ready");
  assert.equal(unstartedPlan({ release: "300.1" }), "409 release_not_available");
  assert.equal(unstartedPlan({ preset: { ...preset, buildStatus: "failed", olderReleases: ["200.1"] } }), "409 release_outdated");
});

test("a switch that a crash left half done can be repeated", () => {
  // The pointer names the release; the record still names the old one.
  assert.equal(unstartedPlan({ pointer: { ...unstarted, desiredRelease: "200.1" } }), "switch");
});

test("the shared refusals still come first", () => {
  assert.equal(unstartedPlan({ record: { ...record, placement: "configured", connectivity: "zerotier" } }), "409 promotion_needs_fleet_world");
  assert.equal(unstartedPlan({ launchEnabled: false }), "409 fleet_unavailable");
  assert.equal(unstartedPlan({ preset: undefined }), "409 preset_removed");
  assert.equal(unstartedPlan({ release: "latest" }), "400 invalid_release");
});

test("a started world is promoted as before and no archive listing is made for it", async (t) => {
  const { inputs, backupChecks } = scenario(t);
  const switched: unknown[] = [];
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }), async (request) => { switched.push(request); return "switched"; });
  assert.equal(result.statusCode, 202);
  assert.equal(inputs.length, 1);
  assert.deepEqual([backupChecks, switched], [[], []]);
});

function unstartedScenario(t: TestContext, hasBackup = false) {
  const base = scenario(t);
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  t.mock.method(sources, "readReleasePointer", async () => ({ state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: null, runCount: 0 }));
  t.mock.method(sources, "hasGenerationBackup", async (worldId: string, generationId: string) => { base.backupChecks.push(`${worldId}/${generationId}`); return hasBackup; });
  return base;
}

test("a never-started world is switched through the same route, with the caller recorded and no workflow", async (t) => {
  const { inputs, backupChecks } = unstartedScenario(t);
  const requests: unknown[] = [];
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }), async (request) => { requests.push(request); return "switched"; });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { result: "switched", release: "200.1", previousRelease: "100.1" });
  assert.deepEqual(requests, [{ worldId: record.worldId, generationId: GENERATION, release: "200.1", updatedBy: "identity:owner" }]);
  assert.deepEqual(backupChecks, [`${record.worldId}/${GENERATION}`]);
  assert.deepEqual(inputs, []);
});

test("a never-started world with a backup, or one that changed meanwhile, is not switched", async (t) => {
  const withBackup = unstartedScenario(t, true);
  let called = false;
  const refusedResult = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }), async () => { called = true; return "switched"; });
  assert.deepEqual([refusedResult.statusCode, JSON.parse(refusedResult.body)], [409, { error: "world_already_started" }]);
  assert.deepEqual([called, withBackup.inputs], [false, []]);
});

test("a switch that loses a race answers 409 world_changed", async (t) => {
  unstartedScenario(t);
  const result = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }), async () => "conflict");
  assert.deepEqual([result.statusCode, JSON.parse(result.body)], [409, { error: "world_changed" }]);
});

test("the update keeps the world running by default, stops it again only on startAfter: false, and refuses a non-boolean", async (t) => {
  const { inputs } = scenario(t);
  const plain = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1" }));
  assert.equal(plain.statusCode, 202);
  assert.equal(JSON.parse(plain.body).startAfter, true);
  assert.equal(inputs[0]?.startAfter, true, "left out, the world keeps running and the idle watchdog stops it");
  const stopped = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1", startAfter: false }));
  assert.equal(stopped.statusCode, 202);
  assert.equal(inputs[1]?.startAfter, false, "false keeps the old closing stop of a stopped origin");
  const wrong = await promoteWorld(owner, "minecraft", record.worldId, JSON.stringify({ release: "200.1", startAfter: "yes" }));
  assert.equal(wrong.statusCode, 400);
  assert.deepEqual(JSON.parse(wrong.body), { error: "invalid_start_after" });
  assert.equal(inputs.length, 2, "a refused request starts no workflow");
});
