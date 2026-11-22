import assert from "node:assert/strict";
import test from "node:test";

import { switchBeforeFirstStart, type SwitchPorts } from "../src/control-plane/release-switch.ts";
import type { ReleaseState } from "../src/control-plane/release-state.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";

const GENERATION = `gen-${"a".repeat(32)}`;
const WORLD = "minecraft-prominenc2-34b8b62d";
const request = { worldId: WORLD, generationId: GENERATION, release: "45059711263.1", updatedBy: "identity:owner" } as const;

const pointer: ReleaseState = {
  worldId: WORLD, generationId: GENERATION, desiredRelease: "39127124115.1", activeRelease: null,
  updatedAt: "2026-11-21T10:00:00.000Z", updatedBy: "world-creation", source: "create-world",
};
const record: WorldRecord = {
  gameId: "minecraft", worldId: WORLD, displayName: "Prominence", status: "active", placement: "fleet", connectivity: "raw", auth: "game",
  preset: { id: "prominence", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: GENERATION, release: "39127124115.1", createdAt: "2026-11-21T10:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};

type Options = Readonly<{
  state?: ReleaseState | null;
  record?: WorldRecord | null;
  holdError?: Error;
  failPointer?: Error;
  failRecord?: Error;
}>;

function ports(options: Options = {}) {
  const calls: string[] = [];
  const written: { pointer?: { state: ReleaseState; etag: string }; record?: { record: WorldRecord; etag: string } } = {};
  const fake: SwitchPorts = {
    holders: { hold: async (identity, worldId, generationId, release, roles) => {
      calls.push(`hold ${identity.gameId}/${identity.presetId} ${worldId} ${generationId} ${release} ${roles.join("+")}`);
      if (options.holdError) throw options.holdError;
    } },
    pointers: {
      read: async () => options.state === null ? null : { state: options.state ?? pointer, etag: "p1" },
      replace: async (state, etag) => { calls.push("pointer"); if (options.failPointer) throw options.failPointer; written.pointer = { state, etag }; },
    },
    worlds: {
      read: async () => options.record === null ? null : { record: options.record ?? record, etag: "w1" },
      replace: async (next, etag) => { calls.push("record"); if (options.failRecord) throw options.failRecord; written.record = { record: next, etag }; },
    },
    now: () => new Date("2026-11-22T08:00:00.000Z"),
  };
  return { fake, calls, written };
}

const lost = Object.assign(new Error("precondition"), { name: "PreconditionFailed" });

test("holders first, then the pointer, then the record, each under the etag it was read with", async () => {
  const { fake, calls, written } = ports();
  assert.equal(await switchBeforeFirstStart(fake, request), "switched");
  assert.deepEqual(calls, [`hold minecraft/prominence ${WORLD} ${GENERATION} 45059711263.1 origin+desired`, "pointer", "record"]);
  assert.deepEqual(written.pointer, { state: {
    ...pointer, desiredRelease: "45059711263.1", updatedAt: "2026-11-22T08:00:00.000Z", updatedBy: "identity:owner", source: "switch-release",
  }, etag: "p1" });
  assert.equal(written.record?.etag, "w1");
  assert.equal(written.record?.record.currentGeneration.release, "45059711263.1");
  assert.deepEqual(written.record?.record.currentGeneration, { ...record.currentGeneration, release: "45059711263.1" });
});

test("a holder that cannot be written stops the switch before any pointer or record write", async () => {
  const { fake, calls } = ports({ holdError: new Error("release_retired") });
  await assert.rejects(switchBeforeFirstStart(fake, request), /release_retired/);
  assert.deepEqual(calls.filter((call) => call === "pointer" || call === "record"), []);
});

test("a wipe that started, ran, changed generation or came from a backup is a conflict and writes nothing", async () => {
  const cases: Options[] = [
    { state: { ...pointer, activeRelease: "39127124115.1" } },
    { state: { ...pointer, releasesRun: [{ release: "39127124115.1", since: "2026-11-21T11:00:00Z" }] } },
    { state: { ...pointer, generationId: `gen-${"b".repeat(32)}` } },
    { record: { ...record, currentGeneration: { ...record.currentGeneration, id: `gen-${"b".repeat(32)}` } } },
    { record: { ...record, currentGeneration: { ...record.currentGeneration, source: { kind: "backup", key: "k", checksum: "c", generationId: "g" } } } },
    { state: null },
    { record: null },
  ];
  for (const options of cases) {
    const { fake, calls } = ports(options);
    assert.equal(await switchBeforeFirstStart(fake, request), "conflict");
    assert.deepEqual(calls, []);
  }
});

test("a pointer that changed since the read is a conflict, and the record is not written", async () => {
  const { fake, calls } = ports({ failPointer: lost });
  assert.equal(await switchBeforeFirstStart(fake, request), "conflict");
  assert.deepEqual(calls.slice(-1), ["pointer"]);
});

test("a record that changed after the pointer moved is a conflict, and a repeat finishes it", async () => {
  const { fake, calls } = ports({ failRecord: lost });
  assert.equal(await switchBeforeFirstStart(fake, request), "conflict");
  assert.deepEqual(calls.slice(-2), ["pointer", "record"]);
  // The pointer already names the release; the same request still passes the never-started check.
  const repeat = ports({ state: { ...pointer, desiredRelease: request.release } });
  assert.equal(await switchBeforeFirstStart(repeat.fake, request), "switched");
});

test("an error that is not a lost race is not hidden", async () => {
  await assert.rejects(switchBeforeFirstStart(ports({ failPointer: new Error("AccessDenied") }).fake, request), /AccessDenied/);
  await assert.rejects(switchBeforeFirstStart(ports({ failRecord: new Error("AccessDenied") }).fake, request), /AccessDenied/);
});
