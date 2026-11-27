import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient } from "@aws-sdk/client-sfn";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { initialLifecycleRecord, type LifecycleRecord } from "../src/domain/lifecycle.ts";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { type ControlPlaneSources, type HostObservation } from "../src/control-plane/read-model.ts";
import { type WorldRecord, worldRecordDocument } from "../src/control-plane/world-registry.ts";
import { InvalidBodyError } from "../src/handlers/api/http.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";
import { awsHostEnvKeys } from "../src/control-plane/aws-host-env-keys.ts";
import { deployedWorlds } from "../src/handlers/api/worlds-wiring.ts";

const { controlSession, controlWorldLifecycle, createWorld, updateWorldSettings, whitelistOf } = deployedWorlds;

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
  /** False: the deployment's persistent host was deleted (ADR-0100). */
  persistentHost?: boolean;
  presets?: readonly PresetObservation[];
  /** The .env keys in SSM; by default every one the games need. */
  hostEnv?: readonly string[];
}> = {}) {
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  const inputs: Record<string, unknown>[] = [];
  t.mock.method(awsHostEnvKeys, "list", async () => options.hostEnv ?? ["RCON_PASSWORD", "PALWORLD_ADMIN_PASSWORD", "ZOMBOID_RCON_PASSWORD", "ZOMBOID_ADMIN_PASSWORD"]);
  t.mock.method(sources, "listHosts", async () => options.persistentHost === false ? [] : [{
    id: "host", name: "Host", state: options.state ?? "stopped", providerRef: "i-12345678", instanceType: null,
    availabilityZone: null, launchedAt: null, publicIp: null, provenance: "configured" as const,
  }]);
  t.mock.method(sources, "listPresets", async () => options.presets ?? []);
  t.mock.method(sources, "listRunningOperations", async () => []);
  t.mock.method(sources, "listWorldRecords", async () => [options.world ?? record]);
  t.mock.method(sources, "readLifecycle", async (key: string) => key.startsWith("world#") ? options.own ?? null : options.game ?? null);
  t.mock.method(sources, "readReleaseManifest", async () => ({}));
  t.mock.method(sources, "readReleaseState", async () => null);
  t.mock.method(SFNClient.prototype, "send", async (command: unknown) => {
    const input = (command as { input: { input: string } }).input;
    inputs.push(JSON.parse(input.input) as Record<string, unknown>);
    return { executionArn: "arn:aws:states:eu-central-1:123456789012:execution:test:operation" };
  });
  return inputs;
}

// ADR-0108: a secret the game needs and SSM lacks refuses the start before any machine runs.
test("a start is refused with the missing keys when the host env lacks the game's secrets", async (t) => {
  const inputs = scenario(t, { hostEnv: ["AWS_REGION"] });
  const refused = await controlSession(identity, "start", "minecraft", record.worldId);
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(JSON.parse(refused.body), { error: "missing_game_secrets", keys: ["RCON_PASSWORD"] });
  assert.deepEqual(inputs, []);
});

test("a stop does not read the host env", async (t) => {
  scenario(t, { game: running(), state: "running" });
  t.mock.method(awsHostEnvKeys, "list", async () => { throw new Error("a stop must not read the host env"); });
  const stopped = await controlSession(identity, "stop", "minecraft", record.worldId);
  assert.notEqual(stopped.statusCode, 500);
});

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

test("a stop disconnects players only when asked, and only for a caller with session.stop.force", async (t) => {
  const inputs = scenario(t, { state: "running", game: running() });
  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId, "")).statusCode, 202);
  assert.equal(inputs[0]?.players, undefined, "a plain stop leaves the machine's refuse default");

  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId, JSON.stringify({ players: "disconnect" }))).statusCode, 202);
  assert.equal(inputs[1]?.players, "disconnect");

  const operator = { id: "operator", displayName: "Operator", roleId: "operator", directGrants: [] } as const;
  const refused = await controlSession(operator, "stop", record.gameId, record.worldId, JSON.stringify({ players: "disconnect" }));
  assert.equal(refused.statusCode, 403);
  const granted = { ...operator, directGrants: ["session.stop.force"] } as const;
  assert.equal((await controlSession(granted, "stop", record.gameId, record.worldId, JSON.stringify({ players: "disconnect" }))).statusCode, 202);

  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId, JSON.stringify({ players: "kick" }))).statusCode, 400);
  await assert.rejects(controlSession(identity, "stop", record.gameId, record.worldId, "[]"), InvalidBodyError);
  assert.equal(inputs.length, 3, "a refused or invalid request dispatches nothing");
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

test("a warm fleet world asks for a warm placement at start; a cold one and a configured one do not", async (t) => {
  const fleet = { ...record, placement: "fleet" as const, connectivity: "raw" as const, auth: "game" as const };
  const warm = scenario(t, { world: { ...fleet, warm: true } });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(warm[0]?.policy, "warm");
  t.mock.restoreAll();
  const cold = scenario(t, { world: fleet });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(cold[0]?.policy, "cold");
  t.mock.restoreAll();
  const configured = scenario(t);
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal("policy" in (configured[0] ?? {}), false);
});

test("with no persistent host a fleet world still starts, stops and archives; a configured world is refused", async (t) => {
  const fleet = { ...record, placement: "fleet" as const, connectivity: "raw" as const, auth: "game" as const };
  const inputs = scenario(t, { world: fleet, persistentHost: false, own: running(`world#${record.worldId}`) });
  assert.equal((await controlSession(identity, "stop", record.gameId, record.worldId)).statusCode, 202);
  assert.equal((await controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "{}")).statusCode, 202);
  t.mock.restoreAll();
  const started = scenario(t, { world: fleet, persistentHost: false });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.deepEqual([...inputs, ...started].map((input) => input.instanceId), ["", "", ""], "a fleet machine finds its host from the placement");
  t.mock.restoreAll();
  const configured = scenario(t, { persistentHost: false });
  const refused = await controlSession(identity, "start", record.gameId, record.worldId);
  assert.deepEqual([refused.statusCode, JSON.parse(refused.body)], [409, { error: "host_not_unique" }]);
  const archive = await controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "{}");
  assert.deepEqual([archive.statusCode, JSON.parse(archive.body)], [409, { error: "configured_host_unavailable" }]);
  assert.deepEqual(configured, []);
});

test("unsafe lifecycle inputs are rejected before any workflow can be dispatched", async (t) => {
  const inputs = scenario(t);
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "restore", record.gameId, record.worldId, JSON.stringify({ backupKey: "worlds/other/archives/save.tar.zst" }))).body), { error: "invalid_backup_key" });
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "purge", record.gameId, record.worldId, "{}")).body), { error: "invalid_purge_confirmation" });
  assert.deepEqual(JSON.parse((await controlWorldLifecycle(identity, "regenerate", record.gameId, record.worldId, JSON.stringify({ release: "../1.2" }))).body), { error: "invalid_release" });
  await assert.rejects(controlWorldLifecycle(identity, "archive", record.gameId, record.worldId, "null"), InvalidBodyError);
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

test("restore verifies the release the backup ran before requesting a workflow", async (t) => {
  const inputs = scenario(t);
  process.env.BACKUP_BUCKET = "backups";
  process.env.RELEASE_BUCKET = "releases";
  t.after(() => { delete process.env.BACKUP_BUCKET; delete process.env.RELEASE_BUCKET; });
  const key = `worlds/${record.worldId}/archives/save-${record.currentGeneration.id}-test.tar.zst`;
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      assert.deepEqual(command.input, { Bucket: "backups", Key: key });
      return { Metadata: { release: "1.4", "release-source": "active" }, LastModified: new Date("2026-11-20T00:00:00Z") };
    }
    throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
  });
  const asked: string[] = [];
  t.mock.method(awsControlPlaneSources as Required<ControlPlaneSources>, "readReleaseManifest", async (_game: string, _preset: string, version: string) => {
    asked.push(version);
    return {};
  });
  assert.equal((await controlWorldLifecycle(identity, "restore", record.gameId, record.worldId, JSON.stringify({ backupKey: key }))).statusCode, 202);
  assert.deepEqual(asked, ["1.4"]);
  assert.equal(inputs[0]?.backupKey, key);
  assert.equal(inputs[0]?.stopRequired, false);
});

test("a restore onto a release that is being retired or is retired is refused before any workflow", async (t) => {
  const inputs = scenario(t);
  process.env.BACKUP_BUCKET = "backups";
  process.env.RELEASE_BUCKET = "releases";
  t.after(() => { delete process.env.BACKUP_BUCKET; delete process.env.RELEASE_BUCKET; });
  const key = `worlds/${record.worldId}/archives/save-${record.currentGeneration.id}-test.tar.zst`;
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { Metadata: { release: "1.4", "release-source": "active" }, LastModified: new Date("2026-11-20T00:00:00Z") };
    throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
  });
  for (const [state, error] of [["retiring", "release_retired"], ["retired", "release_retired"], ["building", "release_not_ready"]] as const) {
    t.mock.method(awsControlPlaneSources as Required<ControlPlaneSources>, "readReleaseState", async () => state);
    const result = await controlWorldLifecycle(identity, "restore", record.gameId, record.worldId, JSON.stringify({ backupKey: key }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error });
  }
  assert.deepEqual(inputs, []);
});

test("a new world is not opened on a release that is being retired, retired or not built (ADR-0080)", async (t) => {
  scenario(t);
  const sources = awsControlPlaneSources as Required<ControlPlaneSources>;
  t.mock.method(sources, "listPresets", async () => [{
    id: "industrial", displayName: "Industrial", gameId: "minecraft", repository: record.preset.repository, commit: record.preset.commit,
    profileDigest: record.preset.profileDigest, releases: ["1.2"], latestRelease: "1.2", buildStatus: "ready" as const,
  }]);
  for (const [state, error] of [["retiring", "release_retired"], ["retired", "release_retired"], ["building", "release_not_ready"]] as const) {
    t.mock.method(sources, "readReleaseState", async () => state);
    const result = await createWorld(identity, "minecraft", "industrial", JSON.stringify({ displayName: "Test", release: "1.2" }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error });
  }
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

function storedWorld(t: TestContext, stored: WorldRecord) {
  process.env.RELEASE_BUCKET = "releases";
  const written: Record<string, unknown>[] = [];
  // The record's release already has its holder, as any stored world's does: a write costs one read.
  const refs = new FakeRefsTable();
  const ref = `release#${stored.gameId}/${stored.preset.id}/${stored.currentGeneration.release}`;
  refs.put({ pk: ref, sk: "meta", layout: "legacy", state: "live", holders: 1 });
  refs.put({ pk: ref, sk: `hold#gen#${stored.worldId}/${stored.currentGeneration.id}`, roles: new Set(["origin"]) });
  t.mock.method(DynamoDBDocumentClient.prototype, "send", (command: unknown) => refs.send(command));
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      return { ETag: "\"v1\"", Body: { transformToString: async () => JSON.stringify(worldRecordDocument(stored)) } };
    }
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfMatch, "\"v1\"");
      written.push(JSON.parse(String(command.input.Body)) as Record<string, unknown>);
      return {};
    }
    throw new Error("unexpected S3 command");
  });
  return written;
}

test("a fleet world's start carries its preset's footprint; without one it sends none", async (t) => {
  const fleet = { ...record, placement: "fleet" as const, connectivity: "raw" as const, auth: "game" as const };
  const preset = { id: record.preset.id, displayName: "Heavy", gameId: record.gameId, repository: record.preset.repository, commit: record.preset.commit, profileDigest: record.preset.profileDigest, releases: ["1.0"], latestRelease: "1.0", buildStatus: "ready" as const };
  const heavy = scenario(t, { world: fleet, presets: [{ ...preset, footprint: { memoryMiB: 14336, cores: 2 } }] });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.deepEqual(heavy[0]?.footprint, { memoryMiB: 14336, cores: 2 });
  t.mock.restoreAll();
  const plain = scenario(t, { world: fleet, presets: [preset] });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal("footprint" in (plain[0] ?? {}), false);
});

test("an On-Demand fleet world asks for On-Demand at start; a Spot one sends nothing new", async (t) => {
  const fleet = { ...record, placement: "fleet" as const, connectivity: "raw" as const, auth: "game" as const };
  const onDemand = scenario(t, { world: { ...fleet, onDemand: true } });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal(onDemand[0]?.market, "on-demand");
  t.mock.restoreAll();
  const spot = scenario(t, { world: fleet });
  assert.equal((await controlSession(identity, "start", record.gameId, record.worldId)).statusCode, 202);
  assert.equal("market" in (spot[0] ?? {}), false);
});

test("hosting settings save the market of a fleet world, and refuse it for the configured host or an unknown value", async (t) => {
  scenario(t);
  const written = storedWorld(t, record);
  const fleet = { placement: "fleet", connectivity: "raw", auth: "game" };
  const saved = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ ...fleet, market: "on-demand" }));
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(JSON.parse(saved.body), { ...fleet, market: "on-demand" });
  assert.equal(written[0]?.on_demand, true);
  const configured = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ placement: "configured", connectivity: "zerotier", market: "spot" }));
  assert.deepEqual(JSON.parse(configured.body), { error: "invalid_world_market" });
  const unknown = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ ...fleet, market: "reserved" }));
  assert.deepEqual(JSON.parse(unknown.body), { error: "invalid_world_market" });
  assert.equal(written.length, 1, "a refused setting writes nothing");
});

test("hosting settings keep a fleet world warm, and refuse warm for the configured host or as a non-boolean", async (t) => {
  scenario(t);
  const written = storedWorld(t, record);
  const fleet = { placement: "fleet", connectivity: "raw", auth: "game" };

  const warm = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ ...fleet, warm: true }));
  assert.equal(warm.statusCode, 200);
  assert.deepEqual(JSON.parse(warm.body), { ...fleet, warm: true });
  assert.equal(written.length, 1);
  assert.equal(written[0]?.warm, true);
  assert.equal(written[0]?.placement, "fleet");

  const configured = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ placement: "configured", connectivity: "zerotier", warm: true }));
  assert.deepEqual(JSON.parse(configured.body), { error: "invalid_world_warm" });
  const text = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ ...fleet, warm: "yes" }));
  assert.deepEqual(JSON.parse(text.body), { error: "invalid_world_warm" });
  assert.equal(written.length, 1, "a refused setting writes nothing");
});

test("changing only the warm choice is saved", async (t) => {
  scenario(t);
  const fleet = { placement: "fleet", connectivity: "raw", auth: "game" } as const;
  const written = storedWorld(t, { ...record, ...fleet });
  const result = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ ...fleet, warm: true }));
  assert.equal(result.statusCode, 200);
  assert.equal(written.length, 1, "a warm-only change writes the record");
  assert.equal(written[0]?.warm, true);
});

test("a warm world that leaves the fleet is cold again", async (t) => {
  scenario(t);
  const written = storedWorld(t, { ...record, placement: "fleet", connectivity: "raw", auth: "game", warm: true });
  const result = await updateWorldSettings("minecraft", record.worldId, JSON.stringify({ placement: "configured", connectivity: "zerotier" }));
  assert.equal(result.statusCode, 200);
  assert.equal(written.length, 1);
  assert.equal("warm" in (written[0] ?? {}), false);
});

// --- Reading the server's whitelist when the world keeps none (ADR-0066) ---------

function serverWhitelist(t: TestContext, reply: Readonly<{ status: string; output: string }>) {
  process.env.CONSOLE_DOCUMENT_NAME = "spawnpoint-console";
  process.env.LIFECYCLE_TABLE_NAME = "lifecycle";
  const sent: SendCommandCommand["input"][] = [];
  t.mock.method(SSMClient.prototype, "send", async (command: unknown) => {
    if (command instanceof SendCommandCommand) {
      sent.push(command.input);
      return { Command: { CommandId: "command-1" } };
    }
    if (command instanceof GetCommandInvocationCommand) return { Status: reply.status, StandardOutputContent: reply.output, StandardErrorContent: "" };
    throw new Error("unexpected SSM command");
  });
  // Only a lookup of the session's host; a console record would be a Put.
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async (command: unknown) => {
    if (command instanceof ScanCommand) return { Items: [] };
    throw new Error("the read must not write a console record");
  });
  return sent;
}

test("a world with no list of its own shows the running server's, and the read is not a console command", async (t) => {
  scenario(t, { state: "running", game: running() });
  storedWorld(t, record);
  const sent = serverWhitelist(t, { status: "Success", output: "There are 2 whitelisted players: DrArzter, Mira\n" });
  const reply = await whitelistOf("minecraft", record.worldId);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(JSON.parse(reply.body), { managed: false, names: ["DrArzter", "Mira"], updatedAt: null, updatedBy: null });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.Parameters?.command, [Buffer.from("whitelist list").toString("base64")]);
});

test("a world that keeps its own list never asks the server", async (t) => {
  scenario(t, { state: "running", game: running() });
  storedWorld(t, { ...record, whitelist: { names: ["Mira"], updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: { identityId: "owner", displayName: "Owner" } } });
  const sent = serverWhitelist(t, { status: "Success", output: "There are 1 whitelisted players: Other" });
  const reply = await whitelistOf("minecraft", record.worldId);
  assert.deepEqual(JSON.parse(reply.body), { managed: true, names: ["Mira"], updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "Owner" });
  assert.equal(sent.length, 0);
});

test("a stopped world with no list shows none and asks no host", async (t) => {
  scenario(t);
  storedWorld(t, record);
  const sent = serverWhitelist(t, { status: "Success", output: "" });
  const reply = await whitelistOf("minecraft", record.worldId);
  assert.deepEqual(JSON.parse(reply.body), { managed: false, names: [], updatedAt: null, updatedBy: null });
  assert.equal(sent.length, 0);
});

test("a server that does not answer with a list is an error, never an empty list", async (t) => {
  scenario(t, { state: "running", game: running() });
  storedWorld(t, record);
  serverWhitelist(t, { status: "Failed", output: "" });
  const reply = await whitelistOf("minecraft", record.worldId);
  assert.equal(reply.statusCode, 502);
  assert.deepEqual(JSON.parse(reply.body), { error: "whitelist_unreadable" });
});
