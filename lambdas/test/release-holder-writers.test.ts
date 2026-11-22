import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ReleaseHolders, resolveFromWorldRecords } from "../src/control-plane/release-holders.ts";
import { ReleaseRefs } from "../src/control-plane/release-refs.ts";
import { releaseStateDocument, type ReleaseState } from "../src/control-plane/release-state.ts";
import { S3ReleaseStateStore } from "../src/control-plane/s3-release-state-store.ts";
import { S3WorldReader, S3WorldRepository } from "../src/control-plane/s3-world-repository.ts";
import { worldRecordDocument, type WorldRecord } from "../src/control-plane/world-registry.ts";
import { run, type Input } from "../src/handlers/release-state.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- The writers of a generation's release ----------------------------------------
// Design 4.8, point (a): every writer of a world record, a release pointer or an
// archive's release metadata is listed here with the way its release is held.
// A new writer that is not listed fails the scan below.

type Coverage =
  | { kind: "store"; why: string }
  | { kind: "operator-script"; why: string; write: RegExp }
  | { kind: "host-archive"; why: string }
  | { kind: "not-a-holder-write"; why: string };

const writers: Readonly<Record<string, Coverage>> = {
  "lambdas/src/control-plane/s3-release-state-store.ts": {
    kind: "store", why: "create and replace add the holders of every release the pointer names (desired, active, run, pre-promotion) before the put",
  },
  "lambdas/src/control-plane/s3-world-repository.ts": {
    kind: "store", why: "create and replace hold the current generation's release as origin before the put",
  },
  "lambdas/src/handlers/world-lifecycle.ts": {
    kind: "store",
    why: "regenerate, restore and archive write through the two stores; purge only deletes keys and writes its own marker, and adds no reference (holders are never removed in this stage)",
  },
  "scripts/migrate-world-state.sh": {
    kind: "operator-script", write: /^put_if_missing "\$\{state_key\}"/m,
    why: "writes the first pointer and the world record; hold_release runs before the first put and stops the script when it fails",
  },
  "scripts/import-world.sh": {
    kind: "operator-script", write: /s3api put-object[^\n]*\\\n[^\n]*\n[^\n]*pointer_key/,
    why: "writes a pointer without a generation; hold_release holds the release as gen#<world>/legacy before the put and stops the script when it fails",
  },
  "server/scripts/upload-world-backup.sh": {
    kind: "host-archive",
    why: "an archive's release is held through its wipe's active or run holder (design 4.8, point 1): the pointer names the release before the host runs it. The host role has no table access, by design",
  },
  "scripts/migrate-release-layout.sh": {
    kind: "not-a-holder-write", why: "writes a release manifest with release metadata: no world record, pointer or archive",
  },
};

const IGNORED = /(^|\/)(node_modules|dist|\.terraform|tests?|\.git)(\/|$)/;
const EXTENSION = /\.(ts|sh|json|tftpl|tf|py|mjs)$/;

function files(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    if (IGNORED.test(path)) return [];
    return statSync(join(root, path)).isDirectory() ? files(path) : EXTENSION.test(name) ? [path] : [];
  });
}

const KEYS = /world\.json|release\.json|releaseStateKey\(|legacyReleaseStateKey\(|release-source|--metadata[^\n]*release=|Metadata:[^\n]*release/;
const WRITES = /PutObjectCommand|CopyObjectCommand|DeleteObjectsCommand|put-object|copy-object|delete-object|aws-sdk:s3:(?:put|copy|delete)Object/;

const scanned = ["lambdas/src", "lambdas/tools", "scripts", "server/scripts", "workflows", "infra"].flatMap(files);
const flagged = scanned.filter((path) => {
  const source = readFileSync(join(root, path), "utf8");
  return KEYS.test(source) && WRITES.test(source);
});

test("every file that writes a world record, a release pointer or archive release metadata is in the writer table", () => {
  assert.deepEqual(flagged.filter((path) => writers[path] === undefined), [], "add the writer to the table, with how its release is held");
});

test("every writer in the table still writes (no stale justification)", () => {
  assert.deepEqual(Object.keys(writers).filter((path) => !flagged.includes(path)), []);
});

test("no workflow writes these keys itself: they call the release-state Lambda or the world-lifecycle Lambda", () => {
  const flaggedWorkflows = flagged.filter((path) => path.startsWith("workflows/"));
  assert.deepEqual(flaggedWorkflows, []);
  for (const path of scanned.filter((entry) => entry.startsWith("workflows/"))) {
    assert.doesNotMatch(readFileSync(join(root, path), "utf8"), /aws-sdk:s3:(?:put|copy)Object|:dynamodb:/, path);
  }
});

test("an operator script writes the holder before its first write and stops when the holder fails", () => {
  for (const [path, coverage] of Object.entries(writers)) {
    if (coverage.kind !== "operator-script") continue;
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /source "\$\{REPOSITORY_ROOT\}\/scripts\/_hold-release\.sh"/, `${path} sources the holder helper`);
    const hold = source.search(/^\s*(?:AWS_PROFILE=\S+ AWS_REGION=\S+ \\\n\s*)?hold_release /m);
    const write = source.search(coverage.write);
    assert.ok(hold !== -1 && write !== -1, `${path} has a holder call and a write`);
    assert.ok(hold < write, `${path} holds before it writes`);
    for (const call of source.matchAll(/hold_release [^\n]*/g)) assert.match(call[0], /\|\| exit 1$/, `${path} stops when the holder fails`);
  }
});

test("the holder helper names a missing node and the tool offers no way to skip the holder", () => {
  const helper = readFileSync(join(root, "scripts/_hold-release.sh"), "utf8");
  assert.match(helper, /command -v node[^\n]*\n[^\n]*node is required/);
  const tool = readFileSync(join(root, "lambdas/tools/hold-release.ts"), "utf8");
  assert.doesNotMatch(tool, /--skip|--force|--no-hold|SKIP|process\.env\.[A-Z_]*(HOLD|BYPASS)/);
});

function arguments_(source: string, from: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]!;
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) {
        args.push(source.slice(start, index).trim());
        return args.filter(Boolean);
      }
      depth -= 1;
    } else if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return args;
}

test("no TypeScript call site builds a writing store without the holders argument", () => {
  const seen: string[] = [];
  for (const path of ["lambdas/src", "lambdas/tools"].flatMap(files).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(/new (S3ReleaseStateStore|S3WorldRepository)\(/g)) {
      const args = arguments_(source, match.index + match[0].length);
      seen.push(`${path} ${match[1]}`);
      assert.ok(args.length >= 3, `${path}: new ${match[1]}(...) needs the holders argument`);
    }
  }
  assert.ok(seen.length >= 6, "the scan finds the writing call sites");
});

// --- Behaviour: the holder comes first and a refusal writes nothing ------------------

const GEN = `gen-${"a".repeat(32)}`;
const NEXT = `gen-${"b".repeat(32)}`;
const base: WorldRecord = {
  gameId: "minecraft", worldId: "alpha", displayName: "Alpha", status: "active", placement: "configured", connectivity: "zerotier",
  preset: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40), profileDigest: "b".repeat(64) },
  currentGeneration: { id: GEN, release: "1.2", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};
const pointer: ReleaseState = {
  worldId: "alpha", generationId: GEN, desiredRelease: "1.2", activeRelease: "1.2", updatedAt: "2026-11-01T00:00:00Z", updatedBy: "seed", source: "seed",
};
const releasePk = (release: string) => `release#minecraft/industrial/${release}`;
const holderSk = (generation: string) => `hold#gen#alpha/${generation}`;

class Bucket {
  readonly objects = new Map<string, { body: string; etag: string }>();
  readonly events: string[] = [];
  /** Called with the key just before a put is stored: the moment the world could name a release. */
  beforePut: ((key: string) => void) | undefined;
  private version = 0;

  seed(key: string, value: unknown) {
    this.objects.set(key, { body: JSON.stringify(value), etag: `"v${(this.version += 1)}"` });
  }

  readonly client = {
    send: async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        const stored = this.objects.get(command.input.Key!);
        if (stored === undefined) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { ETag: stored.etag, Body: { transformToString: async () => stored.body } };
      }
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key!;
        const current = this.objects.get(key);
        if (command.input.IfNoneMatch === "*" && current !== undefined) throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
        if (command.input.IfMatch !== undefined && command.input.IfMatch !== current?.etag) throw Object.assign(new Error("stale"), { name: "PreconditionFailed" });
        this.beforePut?.(key);
        this.events.push(`s3 put ${key}`);
        this.seed(key, JSON.parse(String(command.input.Body)));
        return {};
      }
      throw new Error("unexpected S3 command");
    },
  } as unknown as S3Client;
}

function setup(releases: Readonly<Record<string, "live" | "retiring">> = { "1.2": "live", "1.3": "live" }) {
  const bucket = new Bucket();
  const table = new FakeRefsTable();
  for (const [release, state] of Object.entries(releases)) table.put({ pk: releasePk(release), sk: "meta", layout: "legacy", state, holders: 0 });
  table.beforeSend = (command) => {
    if (command instanceof PutCommand || command instanceof UpdateCommand || command instanceof TransactWriteCommand) bucket.events.push("table write");
  };
  const holders = new ReleaseHolders(new ReleaseRefs(table), resolveFromWorldRecords(new S3WorldReader(bucket.client, "releases")));
  bucket.seed("worlds/alpha/world.json", worldRecordDocument(base));
  bucket.seed(`worlds/alpha/generations/${GEN}/release.json`, releaseStateDocument(pointer));
  return {
    bucket, table,
    states: new S3ReleaseStateStore(bucket.client, "releases", holders),
    worlds: new S3WorldRepository(bucket.client, "releases", holders),
    archives: async () => [{
      key: `worlds/alpha/archives/alpha-${GEN}-20261119T100000Z-${"1".repeat(64)}.tar.zst`, sizeBytes: 1,
      storedAt: "2026-11-19T10:00:00.000Z", checksumAlgorithms: ["SHA256"],
    }],
  };
}

const request = (action: Input["action"], extra: Partial<Input> = {}): Input => ({ action, worldId: "alpha", generationId: GEN, operationId: "op1", ...extra });
const held = (table: FakeRefsTable, release: string, generation = GEN) => [...(table.get(releasePk(release), holderSk(generation))?.roles as Set<string> ?? [])].sort();
const pointerKey = (generation = GEN) => `s3 put worlds/alpha/generations/${generation}/release.json`;

test("prepare holds the new desired release before the pointer is written", async () => {
  const { bucket, table, states, archives } = setup();
  let atPut: string[] = [];
  bucket.beforePut = () => { atPut = held(table, "1.3"); };
  await run(request("prepare", { release: "1.3" }), states, archives);
  assert.deepEqual(atPut, ["desired"], "the holder exists when the pointer is put");
  assert.ok(bucket.events.indexOf("table write") < bucket.events.indexOf(pointerKey()));
});

async function prepared() {
  const scenario = setup();
  await run(request("prepare", { release: "1.3" }), scenario.states, scenario.archives);
  scenario.bucket.events.length = 0;
  return scenario;
}

test("protect holds the kept archive's release as pre-promotion before the pointer is written", async () => {
  const { bucket, table, states, archives } = await prepared();
  let atPut: string[] = [];
  bucket.beforePut = () => { atPut = held(table, "1.2"); };
  const result = await run(request("protect"), states, archives);
  assert.equal((result as { status: string }).status, "protected");
  assert.ok(atPut.includes("pre-promotion"));
  assert.deepEqual(bucket.events.filter((event) => event.startsWith("s3")), [pointerKey()]);
});

test("commit holds the release as active and run before the pointer is written", async () => {
  const { bucket, table, states, archives } = await prepared();
  let atPut: string[] = [];
  bucket.beforePut = () => { atPut = held(table, "1.3"); };
  await run(request("commit", { release: "1.3" }), states, archives);
  assert.deepEqual(atPut, ["active", "desired", "run"]);
  assert.ok(bucket.events.indexOf("table write") < bucket.events.indexOf(pointerKey()));
});

test("rollback and restore add roles to holders that exist and add no new holder", async () => {
  for (const action of ["rollback", "restore"] as const) {
    const { bucket, table, states, archives } = await prepared();
    const before = [1.2, 1.3].map((release) => table.get(releasePk(String(release)), "meta")?.holders);
    let atPut: string[] = [];
    bucket.beforePut = () => { atPut = held(table, "1.2"); };
    await run(request(action, { previous: pointer }), states, archives);
    assert.deepEqual(atPut, ["active", "desired"], action);
    assert.deepEqual([1.2, 1.3].map((release) => table.get(releasePk(String(release)), "meta")?.holders), before, `${action} adds no holder`);
    assert.equal(bucket.events.at(-1), pointerKey());
  }
});

test("a release that is retiring is refused and nothing is written to S3", async () => {
  const { bucket, states, archives } = setup({ "1.2": "live", "1.3": "retiring" });
  await assert.rejects(run(request("prepare", { release: "1.3" }), states, archives), /release_retired/);
  assert.deepEqual(bucket.events.filter((event) => event.startsWith("s3")), []);
});

test("every release a pointer names is held first: a refusal on a later one writes no pointer", async () => {
  const { bucket, states } = setup({ "1.2": "live", "1.3": "retiring" });
  const next: ReleaseState = { ...pointer, desiredRelease: "1.3", activeRelease: "1.3", releasesRun: [{ release: "1.3", since: "x" }] };
  const stored = await states.read({ worldId: "alpha", generationId: GEN });
  await assert.rejects(states.replace(next, stored!.etag), /release_retired/);
  assert.deepEqual(bucket.events.filter((event) => event.startsWith("s3")), []);
});

test("a pointer for a world with no record is refused", async () => {
  const { bucket, states } = setup();
  bucket.objects.delete("worlds/alpha/world.json");
  const stored = await states.read({ worldId: "alpha", generationId: GEN });
  await assert.rejects(states.replace({ ...pointer, desiredRelease: "1.3" }, stored!.etag), /world_record_missing/);
  assert.deepEqual(bucket.events, []);
});

test("world create holds the release, writes the pointer, holds again, then writes the record", async () => {
  const { bucket, table, states, worlds } = setup();
  bucket.objects.clear();
  const fresh: WorldRecord = { ...base, worldId: "beta", currentGeneration: { ...base.currentGeneration, id: NEXT, release: "1.3" } };
  const state: ReleaseState = { ...pointer, worldId: "beta", generationId: NEXT, desiredRelease: "1.3", activeRelease: null };
  await states.create(state, { gameId: "minecraft", presetId: "industrial" });
  await worlds.create(fresh);
  assert.deepEqual(bucket.events, ["table write", "s3 put worlds/beta/generations/" + NEXT + "/release.json", "table write", "s3 put worlds/beta/world.json"]);
  assert.deepEqual([...(table.get(releasePk("1.3"), `hold#gen#beta/${NEXT}`)!.roles as Set<string>)].sort(), ["desired", "origin"]);
});

test("regenerate and restore hold the new generation's release before the record and the pointer", async () => {
  const { bucket, table, states, worlds } = setup();
  const next: WorldRecord = {
    ...base,
    currentGeneration: { id: NEXT, release: "1.3", createdAt: "2026-11-20T00:00:00Z", source: { kind: "backup", key: "worlds/alpha/archives/a.tar.zst", checksum: "c".repeat(64), generationId: GEN } as never },
    previousGenerations: [{ id: GEN, release: "1.2", createdAt: base.currentGeneration.createdAt, closedAt: "2026-11-20T00:00:00Z", source: { kind: "preset" } }] as never,
  };
  const stored = await worlds.read("alpha");
  bucket.events.length = 0;
  await worlds.replace(next, stored!.etag);
  await states.create({ ...pointer, generationId: NEXT, desiredRelease: "1.3", activeRelease: null }, { gameId: "minecraft", presetId: "industrial" });
  assert.deepEqual(bucket.events, ["table write", "s3 put worlds/alpha/world.json", "table write", `s3 put worlds/alpha/generations/${NEXT}/release.json`]);
  assert.deepEqual(held(table, "1.3", NEXT), ["desired", "origin"]);
});

test("a refused regenerate writes neither the record nor the pointer", async () => {
  const { bucket, worlds } = setup({ "1.2": "live", "1.3": "retiring" });
  const stored = await worlds.read("alpha");
  const next: WorldRecord = { ...base, currentGeneration: { id: NEXT, release: "1.3", createdAt: "2026-11-20T00:00:00Z", source: { kind: "preset" } } };
  await assert.rejects(worlds.replace(next, stored!.etag), /release_retired/);
  assert.deepEqual(bucket.events, []);
});

test("a settings update on a world whose release is retiring still works: the holder exists, so nothing new is written to the table", async () => {
  const { bucket, table, worlds } = setup();
  table.put({ pk: releasePk("1.2"), sk: holderSk(GEN), roles: new Set(["origin"]) });
  table.put({ pk: releasePk("1.2"), sk: "meta", layout: "legacy", state: "retiring", holders: 1 });
  const stored = await worlds.read("alpha");
  await worlds.replace({ ...base, displayName: "Alpha renamed" }, stored!.etag);
  assert.deepEqual(bucket.events, ["s3 put worlds/alpha/world.json"]);
});

test("a repeated write costs no table write", async () => {
  const { bucket, states, worlds } = setup();
  const writes = () => bucket.events.filter((event) => event === "table write").length;
  await worlds.replace(base, (await worlds.read("alpha"))!.etag);
  assert.equal(writes(), 1, "the record's release gains the origin holder once");
  await worlds.replace(base, (await worlds.read("alpha"))!.etag);
  assert.equal(writes(), 1);
  await states.replace({ ...pointer, updatedBy: "again" }, (await states.read({ worldId: "alpha", generationId: GEN }))!.etag);
  assert.equal(writes(), 2, "the pointer adds desired and active to the same holder");
  await states.replace({ ...pointer, updatedBy: "third" }, (await states.read({ worldId: "alpha", generationId: GEN }))!.etag);
  assert.equal(writes(), 2);
});
