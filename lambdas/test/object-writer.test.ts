import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CopyObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { s3ObjectPort } from "../src/builder/s3-object-port.ts";
import { gateProjection, holdCatalog, manifestEntries, publishRelease, runPool, withObjectLayout, writeObjects, type Manifest, type ObjectInfo, type ObjectPort, type WriteOptions } from "../src/builder/object-writer.ts";
import { runCommand } from "../src/builder/release-writer-cli.ts";
import { fileItemPk, objectKey, releaseItemPk } from "../src/control-plane/release-objects.ts";
import { holderKey, ReleaseRefs, type ReleaseRef } from "../src/control-plane/release-refs.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";

const ref: ReleaseRef = { gameId: "minecraft", presetId: "industrial", release: "1.0" };
const next: ReleaseRef = { ...ref, release: "1.1" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const b64 = (text: string) => createHash("sha256").update(text).digest("base64");

type Held = { checksum: string; bytes: number };

/** An S3 stand-in that checks what a real bucket checks and records what the writer does. */
class MemoryPort implements ObjectPort {
  readonly objects = new Map<string, Held>();
  readonly puts: string[] = [];
  readonly heads: string[] = [];
  readonly copies: string[] = [];
  peak = 0;
  delay = 0;
  failPut: ((key: string) => boolean) | undefined;
  private running = 0;

  async head(key: string): Promise<ObjectInfo | null> {
    this.heads.push(key);
    const held = this.objects.get(key);
    return held === undefined ? null : { bytes: held.bytes, checksumSha256: held.checksum };
  }

  async put(key: string, source: { path: string; bytes: number }, checksumSha256: string) {
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    try {
      if (this.delay > 0) await new Promise((resolve) => { setTimeout(resolve, this.delay); });
      if (this.failPut?.(key) === true) throw new Error("upload failed");
      const body = await readFile(source.path);
      assert.equal(createHash("sha256").update(body).digest("base64"), checksumSha256, "S3 refuses a body that does not match the checksum");
      if (this.objects.has(key)) return { status: "exists" as const, checksumSha256: undefined };
      this.objects.set(key, { checksum: checksumSha256, bytes: body.length });
      this.puts.push(key);
      return { status: "created" as const, checksumSha256 };
    } finally {
      this.running -= 1;
    }
  }

  async copy(sourceKey: string, key: string) {
    const source = this.objects.get(sourceKey);
    assert.ok(source, "copy of a missing source");
    this.copies.push(key);
    if (this.objects.has(key)) return "exists" as const;
    this.objects.set(key, { ...source });
    return "created" as const;
  }
}

async function payload(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "object-writer-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const entry = (file: string, content: string) => ({ file, sha256: sha(content), bytes: Buffer.byteLength(content) });

function manifestOf(mods: Record<string, string>, extra: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: 1, game: "minecraft", release: "1.0", minecraft_version: "1.20.1", created_at: "2026-11-22T00:00:00Z",
    source_profile: { id: "industrial" }, loader: { type: "fabric", version: "0.19.3" },
    server: { mods: Object.entries(mods).map(([file, content]) => entry(file, content)), overrides: [] },
    ...extra,
  };
}

function setup() {
  const table = new FakeRefsTable();
  const refs = new ReleaseRefs(table, "refs", () => new Date("2026-11-22T00:00:00Z"));
  const port = new MemoryPort();
  const run = (options: Partial<WriteOptions> & Pick<WriteOptions, "sourceDir" | "manifest">) =>
    writeObjects({ refs, port }, { ref, buildId: "b1", packs: {}, concurrency: 4, sleep: async () => {}, ...options });
  return { table, refs, port, run };
}

const meta = (table: FakeRefsTable, r: ReleaseRef = ref) => table.get(releaseItemPk(r.gameId, r.presetId, r.release), "meta");
const fileMeta = (table: FakeRefsTable, digest: string) => table.get(fileItemPk(digest), "meta");

test("a fresh release writes each distinct digest once, under a key without a file name", async () => {
  const { port, run, table } = setup();
  const dir = await payload({ "mods/a.jar": "alpha", "mods/b.jar": "beta", "mods/copy-of-a.jar": "alpha", "overrides/config/x.toml": "gamma", "pack.zip": "zip-bytes" });
  const manifest = manifestOf({ "a.jar": "alpha", "b.jar": "beta", "copy-of-a.jar": "alpha" });
  manifest.server!.overrides = [{ path: "config/x.toml", ...entry("", "gamma") }] as never;
  const result = await run({ sourceDir: dir, manifest, packs: { client: join(dir, "pack.zip") } });
  assert.deepEqual({ total: result.total, created: result.created, reused: result.reused, bytes: result.bytesUploaded }, { total: 4, created: 4, reused: 0, bytes: 5 + 4 + 5 + 9 });
  assert.deepEqual([...port.puts].sort(), [sha("alpha"), sha("beta"), sha("gamma"), sha("zip-bytes")].map(objectKey).sort());
  assert.ok(port.puts.every((key) => /^objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)));
  assert.equal(meta(table)!.state, "building");
  // One back-reference for each digest and release, however many names share it.
  assert.equal(fileMeta(table, sha("alpha"))!.refs, 1);
  await rm(dir, { recursive: true });
});

test("a second release with shared digests uploads only the new ones and verifies the others", async () => {
  const { port, run, table } = setup();
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`m${index}.jar`, `content ${index}`]));
  const dir = await payload(Object.fromEntries(Object.entries(files).map(([name, text]) => [`mods/${name}`, text])));
  await run({ sourceDir: dir, manifest: manifestOf(files) });
  port.puts.length = 0;
  port.heads.length = 0;
  const changed = { ...files, "m9.jar": "content nine, new" };
  const dir2 = await payload(Object.fromEntries(Object.entries(changed).map(([name, text]) => [`mods/${name}`, text])));
  const result = await run({ sourceDir: dir2, manifest: manifestOf(changed, { release: "1.1" }), ref: next, buildId: "b2" });
  assert.deepEqual({ created: result.created, reused: result.reused }, { created: 1, reused: 9 });
  assert.deepEqual(port.puts, [objectKey(sha("content nine, new"))]);
  assert.equal(port.heads.filter((key) => key !== objectKey(sha("content nine, new"))).length, 9);
  assert.equal(fileMeta(table, sha("content 0"))!.refs, 2);
  await rm(dir, { recursive: true });
  await rm(dir2, { recursive: true });
});

test("a wrong object that exists fails the build and is not overwritten", async () => {
  const { port, run, table } = setup();
  const dir = await payload({ "mods/a.jar": "alpha" });
  port.objects.set(objectKey(sha("alpha")), { checksum: b64("other bytes"), bytes: 11 });
  await assert.rejects(run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }) }), /object_mismatch/);
  assert.deepEqual(port.objects.get(objectKey(sha("alpha"))), { checksum: b64("other bytes"), bytes: 11 });
  assert.equal(meta(table)!.state, "building");
  await rm(dir, { recursive: true });
});

test("a reused file whose object is missing is created again from the local file", async () => {
  const { port, run, refs } = setup();
  const dir = await payload({ "mods/a.jar": "alpha" });
  // A crash between the table write and the object write.
  await refs.beginBuild(ref, "crashed");
  await refs.claimFile(ref, { sha256: sha("alpha"), bytes: 5, path: "mods/a.jar" }, { ensureObject: async () => {} });
  const result = await run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }), buildId: "b2" });
  assert.deepEqual({ reused: result.reused, repaired: result.repaired, bytes: result.bytesUploaded }, { reused: 1, repaired: 1, bytes: 5 });
  assert.deepEqual(port.puts, [objectKey(sha("alpha"))]);
  await rm(dir, { recursive: true });
});

test("a 412 on create is treated as present and verified", async () => {
  const { port, run } = setup();
  const dir = await payload({ "mods/a.jar": "alpha" });
  port.objects.set(objectKey(sha("alpha")), { checksum: b64("alpha"), bytes: 5 });
  const result = await run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }) });
  assert.deepEqual({ created: result.created, bytes: result.bytesUploaded, puts: port.puts.length }, { created: 1, bytes: 0, puts: 0 });
  assert.ok(port.heads.includes(objectKey(sha("alpha"))));
  await rm(dir, { recursive: true });
});

test("a deleted file is uploaded again and revived", async () => {
  const { port, run, table } = setup();
  const dir = await payload({ "mods/a.jar": "alpha" });
  table.put({ pk: fileItemPk(sha("alpha")), sk: "meta", state: "deleted", refs: 0, bytes: 5 });
  const result = await run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }) });
  assert.equal(result.recreated, 1);
  assert.deepEqual(port.puts, [objectKey(sha("alpha"))]);
  assert.deepEqual({ state: fileMeta(table, sha("alpha"))!.state, refs: fileMeta(table, sha("alpha"))!.refs }, { state: "live", refs: 1 });
  await rm(dir, { recursive: true });
});

test("a file in deleting makes the build wait, and nothing is uploaded meanwhile", async () => {
  const { port, table, refs } = setup();
  const dir = await payload({ "mods/a.jar": "alpha" });
  table.put({ pk: fileItemPk(sha("alpha")), sk: "meta", state: "deleting", refs: 0, bytes: 5 });
  let sleeps = 0;
  const sleep = async () => {
    sleeps += 1;
    assert.equal(port.puts.length, 0);
    if (sleeps === 2) table.put({ pk: fileItemPk(sha("alpha")), sk: "meta", state: "deleted", refs: 0, bytes: 5 });
  };
  const result = await writeObjects({ refs, port }, { ref, buildId: "b1", packs: {}, concurrency: 2, sleep, sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }) });
  assert.equal(sleeps, 2);
  assert.equal(result.recreated, 1);
  await rm(dir, { recursive: true });
});

test("a local file with the wrong digest or size aborts before any table write for it", async () => {
  const { run, table } = setup();
  const dir = await payload({ "mods/a.jar": "tampered", "mods/b.jar": "short" });
  await assert.rejects(run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha" }), concurrency: 1 }), /local_(digest|size)_mismatch/);
  assert.equal(fileMeta(table, sha("alpha")), undefined);
  assert.equal(fileMeta(table, sha("tampered")), undefined);
  await assert.rejects(run({ sourceDir: dir, manifest: manifestOf({ "b.jar": "shorter" }), concurrency: 1 }), /local_size_mismatch/);
  assert.equal(fileMeta(table, sha("shorter")), undefined);
  await assert.rejects(run({ sourceDir: dir, manifest: manifestOf({ "gone.jar": "gone" }), concurrency: 1 }), /local_file_missing/);
  await rm(dir, { recursive: true });
});

test("one failed upload stops queueing and leaves the release building", async () => {
  const { port, run, table } = setup();
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`m${index}.jar`, `content ${index}`]));
  const dir = await payload(Object.fromEntries(Object.entries(files).map(([name, text]) => [`mods/${name}`, text])));
  port.failPut = (key) => key === objectKey(sha("content 3"));
  await assert.rejects(run({ sourceDir: dir, manifest: manifestOf(files), concurrency: 2 }), /upload failed/);
  assert.ok(port.puts.length < 29);
  assert.equal(meta(table)!.state, "building");
  await rm(dir, { recursive: true });
});

test("the pool never exceeds the configured concurrency and fills it", async () => {
  const { port, run } = setup();
  const files = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`m${index}.jar`, `content ${index}`]));
  const dir = await payload(Object.fromEntries(Object.entries(files).map(([name, text]) => [`mods/${name}`, text])));
  port.delay = 5;
  await run({ sourceDir: dir, manifest: manifestOf(files), concurrency: 3 });
  assert.equal(port.peak, 3);
  assert.equal(port.puts.length, 24);
  await rm(dir, { recursive: true });
});

test("runPool lets running work finish after a failure and starts nothing new", async () => {
  const started: number[] = [];
  const finished: number[] = [];
  await assert.rejects(runPool([0, 1, 2, 3, 4, 5], 2, async (item) => {
    started.push(item);
    await new Promise((resolve) => { setTimeout(resolve, item === 0 ? 1 : 10); });
    if (item === 0) throw new Error("boom");
    finished.push(item);
  }), /boom/);
  assert.deepEqual(finished, [1]);
  assert.ok(started.length < 6);
});

test("a copy from upstream succeeds, and falls back to the local file when the source differs", async () => {
  const { port, run } = setup();
  const dir = await payload({ "mods/a.jar": "alpha", "mods/b.jar": "beta", "mods/c.jar": "gamma" });
  port.objects.set("upstream/curseforge/1/2/a.jar", { checksum: b64("alpha"), bytes: 5 });
  port.objects.set("upstream/curseforge/1/3/b.jar", { checksum: b64("not beta"), bytes: 8 });
  port.objects.set("objects/stolen", { checksum: b64("gamma"), bytes: 5 });
  const upstream = new Map([[sha("alpha"), "upstream/curseforge/1/2/a.jar"], [sha("beta"), "upstream/curseforge/1/3/b.jar"], [sha("gamma"), "objects/stolen"]]);
  const result = await run({ sourceDir: dir, manifest: manifestOf({ "a.jar": "alpha", "b.jar": "beta", "c.jar": "gamma" }), upstream });
  assert.equal(result.copied, 1);
  assert.deepEqual(port.copies, [objectKey(sha("alpha"))]);
  assert.deepEqual([...port.puts].sort(), [objectKey(sha("beta")), objectKey(sha("gamma"))].sort());
  // Nothing is ever written under upstream/.
  assert.ok(port.puts.every((key) => key.startsWith("objects/")));
  await rm(dir, { recursive: true });
});

test("the manifest rewrite adds storage and packs and leaves the gate's fields byte-identical", () => {
  const manifest = manifestOf({ "a.jar": "alpha" }, {
    runtime: { image: "repo/image@sha256:" + "a".repeat(64) },
    client: { kind: "mod-set", mods: [entry("c.jar", "gamma")] },
  } as never);
  const packs = { client: { sha256: sha("c"), bytes: 1 }, server: { sha256: sha("s"), bytes: 2 }, full: { sha256: sha("f"), bytes: 3 } };
  const rewritten = withObjectLayout(manifest, packs);
  assert.deepEqual(rewritten.storage, { layout: "objects-v1" });
  assert.deepEqual(rewritten.packs, { client: packs.client, server: packs.server, full: packs.full });
  assert.equal(gateProjection(rewritten), gateProjection(manifest));
  for (const field of ["client", "server", "loader", "runtime"] as const) assert.equal(JSON.stringify(rewritten[field]), JSON.stringify(manifest[field]));
  // A modpack already names its client pack inside the gate: it is not repeated, and `client` is not touched.
  const modpack = manifestOf({ "a.jar": "alpha" }, { client: { kind: "curseforge-modpack", ...entry("client.zip", "zip") } } as never);
  const again = withObjectLayout(modpack, { client: { sha256: sha("zip"), bytes: 3 } });
  assert.equal(again.packs, undefined);
  assert.equal(gateProjection(again), gateProjection(modpack));
});

test("manifestEntries gives one entry for each digest, with every name as a source", () => {
  const dir = "/payload";
  const entries = manifestEntries(manifestOf({ "a.jar": "alpha", "dup.jar": "alpha" }, { client: { kind: "mod-set", mods: [entry("only-client.jar", "beta"), entry("a.jar", "alpha")] } } as never), dir);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0]!.sources.slice(0, 2), ["/payload/mods/a.jar", "/payload/mods/dup.jar"]);
  assert.deepEqual(entries[1]!.sources, ["/payload/client-mods/only-client.jar", "/payload/mods/only-client.jar"]);
});

function spyRefs(refs: ReleaseRefs) {
  const calls: string[] = [];
  return {
    calls,
    refs: {
      publish: async (r: ReleaseRef) => { calls.push("publish"); await refs.publish(r); },
      hold: async (r: ReleaseRef, key: string, roles: never) => { calls.push(`hold ${key}`); await refs.hold(r, key, roles); },
      dropHolder: async (r: ReleaseRef, key: string) => { calls.push(`drop ${key}`); await refs.dropHolder(r, key); },
    },
  };
}

test("publish sets live, adds the catalog holder first, then drops the build holder, and can repeat", async () => {
  const { refs, table } = setup();
  await refs.beginBuild(ref, "b1");
  const spy = spyRefs(refs);
  await publishRelease(spy.refs, ref, "b1");
  assert.deepEqual(spy.calls, ["publish", `hold ${holderKey.catalog("minecraft")}`, `drop ${holderKey.build("b1")}`]);
  assert.deepEqual({ state: meta(table)!.state, holders: meta(table)!.holders }, { state: "live", holders: 1 });
  await publishRelease(spy.refs, ref, "b1");
  assert.deepEqual({ state: meta(table)!.state, holders: meta(table)!.holders }, { state: "live", holders: 1 });
  assert.ok(table.get(releaseItemPk("minecraft", "industrial", "1.0"), `hold#${holderKey.catalog("minecraft")}`));
});

test("hold-catalog holds each release, registering a legacy one the table does not know", async () => {
  const { refs, table } = setup();
  await refs.beginBuild(ref, "b1");
  await refs.publish(ref);
  await holdCatalog(refs, "minecraft", "industrial", ["1.0", "0.9"]);
  assert.equal(meta(table)!.holders, 2);
  assert.deepEqual({ layout: meta(table, { ...ref, release: "0.9" })!.layout, state: meta(table, { ...ref, release: "0.9" })!.state }, { layout: "legacy", state: "live" });
  await holdCatalog(refs, "minecraft", "industrial", ["1.0"]);
  assert.equal(meta(table)!.holders, 2);
});

test("heal verifies an existing release, recreates a missing object from a matching local file and fails when it cannot", async () => {
  const { port, run, table } = setup();
  const files = { "a.jar": "alpha", "b.jar": "beta" };
  const dir = await payload({ "mods/a.jar": "alpha", "mods/b.jar": "beta", "client.zip": "pack", "rebuilt.zip": "different zip" });
  const manifest = withObjectLayout(manifestOf(files), { client: { sha256: sha("pack"), bytes: 4 } });
  await run({ sourceDir: dir, manifest: withObjectLayout(manifestOf(files), {}), packs: { client: join(dir, "client.zip") } });
  port.objects.delete(objectKey(sha("alpha")));
  const healed = await run({ sourceDir: dir, manifest, heal: true, packs: { client: join(dir, "client.zip") }, buildId: "heal" });
  assert.deepEqual({ reused: healed.reused, repaired: healed.repaired }, { reused: 3, repaired: 1 });
  assert.ok(port.objects.has(objectKey(sha("alpha"))));
  // The pack's object is gone and the rebuilt zip is not the stored one: it cannot be created again.
  port.objects.delete(objectKey(sha("pack")));
  await assert.rejects(run({ sourceDir: dir, manifest, heal: true, packs: { client: join(dir, "rebuilt.zip") }, buildId: "heal2" }), /object_missing_no_source/);
  assert.equal(meta(table)!.state, "building");
  await rm(dir, { recursive: true });
});

// The port against a fake SDK client: what actually goes on the wire.
test("the S3 port writes conditionally with the checksum, no metadata and no name, and reads 412, 403 and 404 as the writer needs", async () => {
  const dir = await payload({ "f.bin": "alpha" });
  const sent: unknown[] = [];
  const answers: Array<(command: unknown) => unknown> = [];
  const client = { send: async (command: unknown) => { sent.push(command); return answers.shift()!(command); } };
  const port = s3ObjectPort(client as never, "bucket", { sleep: async () => {} });

  answers.push(() => ({ ChecksumSHA256: b64("alpha") }));
  assert.deepEqual(await port.put("objects/k", { path: join(dir, "f.bin"), bytes: 5 }, b64("alpha")), { status: "created", checksumSha256: b64("alpha") });
  const put = sent[0] as PutObjectCommand;
  assert.ok(put instanceof PutObjectCommand);
  const { Body, ...input } = put.input;
  (Body as { destroy: () => void }).destroy();
  assert.deepEqual(input, {
    Bucket: "bucket", Key: "objects/k", ContentLength: 5, ContentType: "application/octet-stream", ServerSideEncryption: "AES256",
    ChecksumAlgorithm: "SHA256", ChecksumSHA256: b64("alpha"), IfNoneMatch: "*",
  });

  answers.push(() => { throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }); });
  assert.equal((await port.put("objects/k", { path: join(dir, "f.bin"), bytes: 5 }, b64("alpha"))).status, "exists");
  ((sent[1] as PutObjectCommand).input.Body as { destroy: () => void }).destroy();

  answers.push(() => { throw Object.assign(new Error("denied"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }); });
  assert.equal(await port.head("objects/missing"), null);
  assert.ok(sent[2] instanceof HeadObjectCommand && (sent[2] as HeadObjectCommand).input.ChecksumMode === "ENABLED");
  answers.push(() => ({ ContentLength: 5, ChecksumSHA256: b64("alpha") }));
  assert.deepEqual(await port.head("objects/k"), { bytes: 5, checksumSha256: b64("alpha") });

  answers.push(() => ({}));
  await port.copy("upstream/curseforge/1/2/a b.jar", "objects/k");
  const copy = sent[4] as CopyObjectCommand;
  assert.equal(copy.input.CopySource, "bucket/upstream/curseforge/1/2/a%20b.jar");
  assert.equal(copy.input.IfNoneMatch, "*");
  await rm(dir, { recursive: true });
});

test("the S3 port retries a transient error with a fresh stream and does not retry other errors", async () => {
  const dir = await payload({ "f.bin": "alpha" });
  const bodies: unknown[] = [];
  let calls = 0;
  const client = {
    send: async (command: PutObjectCommand) => {
      bodies.push(command.input.Body);
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
      return { ChecksumSHA256: b64("alpha") };
    },
  };
  const port = s3ObjectPort(client as never, "bucket", { sleep: async () => {} });
  const result = await port.put("objects/k", { path: join(dir, "f.bin"), bytes: 5 }, b64("alpha"));
  assert.equal(result.status, "created");
  assert.equal(new Set(bodies).size, 3);
  for (const body of bodies) (body as { destroy: () => void }).destroy();

  const failing = { send: async () => { calls += 1; throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 400 } }); } };
  calls = 0;
  await assert.rejects(s3ObjectPort(failing as never, "bucket", { sleep: async () => {} }).put("objects/k", { path: join(dir, "f.bin"), bytes: 5 }, b64("alpha")), /denied/);
  assert.equal(calls, 1);
  await rm(dir, { recursive: true });
});

// The command: arguments, result lines, exit codes, and the manifest file.
test("the write command prints result lines, rewrites the manifest and leaves it alone when the run fails", async () => {
  const { refs, port, table } = setup();
  const dir = await payload({ "mods/a.jar": "alpha", "pack.zip": "zip" });
  const manifestPath = join(dir, "manifest.json");
  const manifest = manifestOf({ "a.jar": "alpha" }, { client: { kind: "mod-set", mods: [entry("a.jar", "alpha")] } } as never);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const out: string[] = [];
  const err: string[] = [];
  const make = () => ({ port, refs });
  const common = ["--manifest", manifestPath, "--source-dir", dir, "--game", "minecraft", "--preset", "industrial", "--release", "1.0", "--build-id", "b1"];
  const env = { RELEASE_BUCKET: "bucket", RELEASE_UPLOAD_CONCURRENCY: "2" };

  port.failPut = () => true;
  assert.equal(await runCommand(["write", ...common, "--pack", `server=${join(dir, "pack.zip")}`], env, make, { out: (line) => out.push(line), err: (line) => err.push(line) }), 1);
  assert.equal(err.at(-1), "error=internal_error");
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), JSON.parse(JSON.stringify(manifest)));
  assert.equal(meta(table)!.state, "building");

  port.failPut = undefined;
  out.length = 0;
  assert.equal(await runCommand(["write", ...common, "--pack", `server=${join(dir, "pack.zip")}`], env, make, { out: (line) => out.push(line), err: (line) => err.push(line) }), 0);
  // The failed run counted the references: the retry verifies them and repairs the missing objects.
  assert.match(out.pop() ?? "", /^writer_seconds=\d+$/);
  assert.deepEqual(out, ["layout=objects-v1", "objects_total=2", "objects_created=0", "objects_reused=2", "objects_recreated=0", "objects_repaired=2", "objects_copied=0", "bytes_uploaded=8"]);
  const written = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  assert.deepEqual(written.storage, { layout: "objects-v1" });
  assert.deepEqual(written.packs, { server: { sha256: sha("zip"), bytes: 3 } });

  out.length = 0;
  assert.equal(await runCommand(["publish", "--game", "minecraft", "--preset", "industrial", "--release", "1.0", "--build-id", "b1"], env, make, { out: (line) => out.push(line), err: (line) => err.push(line) }), 0);
  assert.deepEqual(out, ["release_state=live"]);
  assert.equal(await runCommand(["hold-catalog", "--game", "minecraft", "--preset", "industrial", "--releases", "1.0"], env, make, { out: (line) => out.push(line), err: (line) => err.push(line) }), 0);
  assert.equal(out.at(-1), "catalog_holders=1");

  err.length = 0;
  assert.equal(await runCommand(["write", "--bogus"], env, make, { out: () => {}, err: (line) => err.push(line) }), 2);
  assert.equal(err.at(-1), "error=invalid_arguments");
  assert.equal(await runCommand(["publish", "--game", "minecraft", "--preset", "industrial", "--release", "1.x", "--build-id", "b1"], env, make, { out: () => {}, err: () => {} }), 2);
  assert.equal(await runCommand(["write"], { RELEASE_UPLOAD_CONCURRENCY: "2" }, make, { out: () => {}, err: () => {} }), 2);
  await rm(dir, { recursive: true });
});
