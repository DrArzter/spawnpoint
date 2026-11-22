import assert from "node:assert/strict";
import test from "node:test";

import { fileItemPk, releaseItemPk } from "../src/control-plane/release-objects.ts";
import { ReleaseRefs, holderKey, type FileClaim, type ObjectMode } from "../src/control-plane/release-refs.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";

const ref = { gameId: "minecraft", presetId: "industrial", release: "1.2" };
const other = { ...ref, release: "1.3" };
const A = "a".repeat(64);
const B = "b".repeat(64);
const file = (sha256: string, path = "mods/x.jar"): FileClaim => ({ sha256, bytes: 10, path });

function setup() {
  const table = new FakeRefsTable();
  const refs = new ReleaseRefs(table, "refs", () => new Date("2026-11-22T00:00:00Z"));
  const modes: ObjectMode[] = [];
  const ensure = async (_file: FileClaim, mode: ObjectMode) => { modes.push(mode); };
  return { table, refs, modes, options: { ensureObject: ensure, sleep: async () => {} } };
}

const meta = (table: FakeRefsTable, r = ref) => table.get(releaseItemPk(r.gameId, r.presetId, r.release), "meta");
const fileMeta = (table: FakeRefsTable, sha: string) => table.get(fileItemPk(sha), "meta");

test("a build creates the release item as building with its own holder, and repeats safely", async () => {
  const { table, refs } = setup();
  await refs.beginBuild(ref, "b1", "d".repeat(64));
  assert.deepEqual({ layout: meta(table)!.layout, state: meta(table)!.state, holders: meta(table)!.holders }, { layout: "objects", state: "building", holders: 1 });
  await refs.beginBuild(ref, "b1");
  assert.equal(meta(table)!.holders, 1);
  await refs.beginBuild(ref, "b2");
  assert.equal(meta(table)!.holders, 2);
});

test("a first file is counted, then created; a second release reuses it, verifies it and counts 2", async () => {
  const { table, refs, modes, options } = setup();
  await refs.beginBuild(ref, "b1");
  assert.equal(await refs.claimFile(ref, file(A), options), "created");
  assert.deepEqual({ refs: fileMeta(table, A)!.refs, state: fileMeta(table, A)!.state }, { refs: 1, state: "live" });
  await refs.beginBuild(other, "b2");
  assert.equal(await refs.claimFile(other, file(A), options), "reused");
  assert.equal(fileMeta(table, A)!.refs, 2);
  assert.deepEqual(modes, ["create", "verify"]);
  assert.ok(table.get(fileItemPk(A), "release#minecraft/industrial/1.3"));
});

test("the reference is counted before the object is written", async () => {
  const { table, refs } = setup();
  await refs.beginBuild(ref, "b1");
  let seen: unknown;
  await refs.claimFile(ref, file(A), { sleep: async () => {}, ensureObject: async () => { seen = fileMeta(table, A)?.refs; } });
  assert.equal(seen, 1);
});

test("a crash between the table write and the object write leaves a reference and no object; the retry verifies the object and does not count twice", async () => {
  const { table, refs, modes, options } = setup();
  await refs.beginBuild(ref, "b1");
  await assert.rejects(refs.claimFile(ref, file(A), { sleep: async () => {}, ensureObject: async () => { throw new Error("process killed"); } }), /process killed/);
  assert.equal(fileMeta(table, A)!.refs, 1);
  assert.equal(meta(table)!.state, "building");
  // The same release again, as a retried build: the reference is already there.
  assert.equal(await refs.claimFile(ref, file(A), options), "reused");
  assert.equal(fileMeta(table, A)!.refs, 1);
  assert.deepEqual(modes, ["verify"]);
});

test("a file that is condemned is revived by a reuse", async () => {
  const { table, refs, options } = setup();
  table.put({ pk: fileItemPk(A), sk: "meta", state: "condemned", refs: 0, bytes: 10, condemned_at: "2026-11-01T00:00:00Z" });
  await refs.beginBuild(ref, "b1");
  await refs.claimFile(ref, file(A), options);
  const item = fileMeta(table, A)!;
  assert.deepEqual({ state: item.state, refs: item.refs, condemned: "condemned_at" in item }, { state: "live", refs: 1, condemned: false });
});

test("reuse during a delete: a build waits while the file is deleting and does not write", async () => {
  const { table, refs, modes } = setup();
  table.put({ pk: fileItemPk(A), sk: "meta", state: "deleting", refs: 0, bytes: 10 });
  await refs.beginBuild(ref, "b1");
  let waits = 0;
  const done = await refs.claimFile(ref, file(A), {
    ensureObject: async (_f, mode) => { modes.push(mode); },
    sleep: async () => {
      waits += 1;
      assert.equal(modes.length, 0, "nothing is uploaded while the file is deleting");
      if (waits === 2) table.put({ pk: fileItemPk(A), sk: "meta", state: "deleted", refs: 0, bytes: 10 });
    },
  });
  assert.equal(done, "recreated");
  assert.ok(waits >= 2);
});

test("a deleted file is uploaded again, then revived under state = deleted with refs 1", async () => {
  const { table, refs, options } = setup();
  table.put({ pk: fileItemPk(A), sk: "meta", state: "deleted", refs: 0, bytes: 10 });
  await refs.beginBuild(ref, "b1");
  const order: string[] = [];
  const result = await refs.claimFile(ref, file(A), {
    sleep: options.sleep,
    ensureObject: async (_f, mode) => { order.push(`${mode}:${String(fileMeta(table, A)!.state)}`); },
  });
  assert.equal(result, "recreated");
  assert.deepEqual(order, ["recreate:deleted"]);
  assert.deepEqual({ state: fileMeta(table, A)!.state, refs: fileMeta(table, A)!.refs }, { state: "live", refs: 1 });
});

test("the revival loses to another build that revived first, and then counts as an ordinary reuse", async () => {
  const { table, refs, modes, options } = setup();
  table.put({ pk: fileItemPk(A), sk: "meta", state: "deleted", refs: 0, bytes: 10 });
  await refs.beginBuild(ref, "b1");
  const result = await refs.claimFile(ref, file(A), {
    sleep: options.sleep,
    ensureObject: async (_f, mode) => {
      modes.push(mode);
      if (mode === "recreate") table.put({ pk: fileItemPk(A), sk: "meta", state: "live", refs: 1, bytes: 10 });
    },
  });
  assert.equal(result, "reused");
  assert.equal(fileMeta(table, A)!.refs, 2);
  assert.deepEqual(modes, ["recreate", "verify"]);
});

test("a file that waits too long for a delete is an error, never an upload", async () => {
  const { table, refs, modes } = setup();
  table.put({ pk: fileItemPk(B), sk: "meta", state: "deleting", refs: 0, bytes: 10 });
  await refs.beginBuild(ref, "b1");
  let clock = 0;
  const timed = new ReleaseRefs(table, "refs", () => new Date(clock));
  await assert.rejects(timed.claimFile(ref, file(B), {
    waitMilliseconds: 1000, ensureObject: async (_f, mode) => { modes.push(mode); },
    sleep: async () => { clock += 600; },
  }), /file_deleting_timeout/);
  assert.deepEqual(modes, []);
});

test("a holder is added only while the release is live; the build holder while it is building or live", async () => {
  const { table, refs } = setup();
  await refs.beginBuild(ref, "b1");
  await assert.rejects(refs.hold(ref, holderKey.generation("w", "gen-1"), ["origin"]), /release_not_ready/);
  await refs.publish(ref);
  await refs.hold(ref, holderKey.generation("w", "gen-1"), ["origin"]);
  await refs.hold(ref, holderKey.catalog("minecraft"), ["catalog"]);
  await refs.dropHolder(ref, holderKey.build("b1"));
  assert.equal(meta(table)!.holders, 2);
  table.put({ ...meta(table)!, state: "retiring" });
  await assert.rejects(refs.hold(ref, holderKey.generation("w", "gen-2"), ["origin"]), /release_retired/);
  await assert.rejects(refs.hold(ref, holderKey.build("b3"), ["build"]), /release_retired/);
});

test("a holder that exists gets a new role without another count, and an existing role costs no write", async () => {
  const { table, refs } = setup();
  await refs.beginBuild(ref, "b1");
  await refs.publish(ref);
  const key = holderKey.generation("w", "gen-1");
  await refs.hold(ref, key, ["origin"]);
  await refs.hold(ref, key, ["active", "run"]);
  assert.deepEqual([...(table.get(releaseItemPk("minecraft", "industrial", "1.2"), `hold#${key}`)!.roles as Set<string>)].sort(), ["active", "origin", "run"]);
  assert.equal(meta(table)!.holders, 2);
  const before = table.commands.length;
  await refs.hold(ref, key, ["origin"]);
  assert.equal(table.commands.length - before, 2, "a read of the release and a read of the holder only");
  assert.equal(meta(table)!.holders, 2);
});

test("a holder for a release the table does not know registers it as legacy first, and even an existing holder is refused while it is retiring", async () => {
  const { table, refs } = setup();
  const key = holderKey.generation("w", "gen-1");
  await refs.hold(ref, key, ["origin"]);
  assert.deepEqual({ layout: meta(table)!.layout, state: meta(table)!.state, holders: meta(table)!.holders }, { layout: "legacy", state: "live", holders: 1 });
  table.put({ ...meta(table)!, state: "retiring" });
  // A pointer that turns back to a retiring release must not slip in after the retirement's live check.
  await assert.rejects(refs.hold(ref, key, ["origin"]), /release_retired/);
  await assert.rejects(refs.hold(ref, holderKey.generation("w", "gen-2"), ["origin"]), /release_retired/);
});

test("a build holder needs a release that was begun", async () => {
  const { refs } = setup();
  await assert.rejects(refs.hold(ref, holderKey.build("b1"), ["build"]), /release_not_begun/);
});

test("publishing is safe to repeat and refuses a retired release", async () => {
  const { table, refs } = setup();
  await refs.beginBuild(ref, "b1");
  await refs.publish(ref);
  await refs.publish(ref);
  assert.equal(meta(table)!.state, "live");
  table.put({ ...meta(table)!, state: "retired" });
  await assert.rejects(refs.publish(ref), /release_retired/);
});

test("a digest that is not a SHA-256 is refused before any write", async () => {
  const { table, refs, options } = setup();
  await assert.rejects(refs.claimFile(ref, file("../x"), options), /invalid_digest/);
  assert.equal(table.items.size, 0);
});
