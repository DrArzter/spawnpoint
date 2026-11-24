import assert from "node:assert/strict";
import test from "node:test";

import { fileItemPk, objectKey } from "../src/control-plane/release-objects.ts";
import { ReleaseRefs } from "../src/control-plane/dynamo-release-refs.ts";
import { compare, mark, tableView, type ManifestSource, type TableItem } from "../src/control-plane/release-reconciler.ts";
import {
  describeSweep, executeSweep, planSweep, sweepCandidates, sweepCutoff, sweepDryRun, sweepGraceDays, type SweepPlan, type SweepWriter,
} from "../src/control-plane/release-sweep.ts";
import { sweepWriter } from "../src/control-plane/s3-release-sweep.ts";
import { reconcile, sweepMetrics, type Metric, type ReconcilerDeps } from "../src/handlers/release-reconciler.ts";
import { FakeRefsTable } from "./fake-refs-table.ts";

const START = "2026-11-22T05:00:00.000Z";
const LATER = new Date("2026-11-22T05:10:00.000Z");
const OLD = "2026-11-01T00:00:00.000Z"; // 21 days before the start
const RECENT = "2026-11-15T00:00:00.000Z"; // 7 days before the start
const R11 = "minecraft/preset/1.1";

function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

const objectsManifest = {
  storage: { layout: "objects-v1" },
  server: { mods: [{ file: "a.jar", sha256: digest(1), bytes: 1 }], overrides: [] },
  client: { kind: "mod-set", sha256: digest(2), bytes: 1, mods: [] },
};

function manifest(release: string, value: unknown): ManifestSource {
  const [gameId, presetId, version] = release.split("/") as [string, string, string];
  return { ref: { gameId, presetId, release: version }, manifest: value };
}

const condemned = (n: number, extra: Record<string, unknown> = {}): TableItem => ({ pk: fileItemPk(digest(n)), sk: "meta", refs: 0, state: "condemned", bytes: 5, condemned_at: OLD, ...extra });

type Scenario = Readonly<{
  keys?: readonly string[];
  manifests?: readonly ManifestSource[];
  failures?: readonly { source: string; subject: string; reason: string }[];
  startedAt?: string;
  listing?: null;
  table?: null;
  grace?: number;
}>;

function planOf(items: readonly TableItem[], scenario: Scenario = {}): SweepPlan {
  const marks = mark({
    manifestsListed: true, manifests: scenario.manifests ?? [], worlds: [], pointers: [], archives: [], catalogs: [],
    retired: new Set(), failures: scenario.failures ?? [],
  });
  const table = scenario.table === null ? null : tableView(items);
  const listing = scenario.listing === null ? null : { keys: scenario.keys ?? [] };
  const startedAt = scenario.startedAt ?? START;
  const report = compare(marks, table, listing, startedAt, startedAt);
  return planSweep({ report, marks, table, listing, graceDays: scenario.grace ?? 14 });
}

const digestsOf = (plan: SweepPlan, kind: string) => plan.actions.filter((action) => action.kind === kind).map((action) => action.digest);

// --- the proofs -------------------------------------------------------------

test("a condemned, unreferenced, unnamed file past its grace in a complete run is a delete", () => {
  const plan = planOf([condemned(1)], { keys: [objectKey(digest(1))] });
  assert.equal(plan.reason, null);
  assert.deepEqual(plan.actions, [{ kind: "delete", digest: digest(1) }]);
  assert.equal(sweepCandidates(plan), 1);
  assert.equal(plan.cutoff, "2026-11-08T05:00:00.000Z");
  assert.equal(sweepCutoff(START, 1), "2026-11-21T05:00:00.000Z");
});

test("each proof alone blocks the delete", () => {
  const listing = { keys: [objectKey(digest(1))] };
  const backRef = { pk: fileItemPk(digest(1)), sk: "release#minecraft/preset/1.0", path: "x" };
  const cases: ReadonlyArray<readonly [string, readonly TableItem[], Scenario]> = [
    ["refs above zero", [condemned(1, { refs: 1 })], listing],
    ["state live", [condemned(1, { state: "live" })], listing],
    ["condemned less than the grace ago", [condemned(1, { condemned_at: RECENT })], listing],
    ["condemned_at missing", [condemned(1, { condemned_at: undefined })], listing],
    ["named by a manifest", [condemned(1)], { ...listing, manifests: [manifest(R11, objectsManifest)] }],
    ["a back-reference in the table", [condemned(1), backRef], listing],
    ["condemned after the run started", [condemned(1, { condemned_at: "2026-11-22T06:00:00.000Z" })], { ...listing, grace: 1 }],
  ];
  for (const [name, items, scenario] of cases) {
    const plan = planOf(items, scenario);
    assert.equal(plan.reason, null, name);
    assert.deepEqual(digestsOf(plan, "delete"), [], name);
  }
});

test("a run that could not read a source plans nothing, with the reason incomplete_run", () => {
  const listing = { keys: [objectKey(digest(1))] };
  const failing = planOf([condemned(1)], { ...listing, failures: [{ source: "world", subject: "worlds/x/world.json", reason: "AccessDenied" }] });
  assert.deepEqual({ reason: failing.reason, actions: failing.actions }, { reason: "incomplete_run", actions: [] });
  assert.equal(planOf([condemned(1)], { ...listing, table: null }).reason, "incomplete_run");
  assert.equal(planOf([condemned(1)], { listing: null }).reason, "incomplete_run");
});

test("a legacy release has no objects/ digest, so nothing of it is planned", () => {
  const legacy = [{ pk: "release#minecraft/preset/1.0", sk: "meta", layout: "legacy", state: "live", holders: 1 }];
  const plan = planOf(legacy, { manifests: [manifest("minecraft/preset/1.0", { server: { mods: [{ file: "a.jar", sha256: digest(1), bytes: 1 }] } })] });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.reason, null);
});

test("a condemned file is not a delete while a building release holds a reference to it", () => {
  const items = [
    condemned(1, { refs: 0 }),
    { pk: "release#minecraft/preset/1.2", sk: "meta", state: "building", layout: "objects" },
    { pk: fileItemPk(digest(1)), sk: "release#minecraft/preset/1.2", path: "x" },
  ];
  assert.deepEqual(planOf(items, { keys: [objectKey(digest(1))] }).actions, []);
});

// --- the executor -----------------------------------------------------------

type Rig = ReturnType<typeof rig>;

function rig(items: readonly TableItem[], options: { failDelete?: boolean } = {}) {
  const table = new FakeRefsTable();
  for (const item of items) table.put(item);
  const events: string[] = [];
  const deleted: string[] = [];
  table.beforeSend = () => { events.push("table:update"); };
  const s3 = {
    async send(command: { input: Record<string, unknown> }) {
      const key = String(command.input.Key);
      const pk = `file#${key.split("/").pop()}`;
      events.push(`s3:delete(${String(table.get(pk, "meta")?.state)})`);
      await new Promise<void>((resolve) => { setImmediate(resolve); }); // let a concurrent writer run
      if (options.failDelete) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
      deleted.push(key);
      return {};
    },
  };
  const commands: Record<string, unknown>[] = [];
  const spy = { send: (command: { input: Record<string, unknown> }) => { commands.push(command.input); return s3.send(command); } };
  return { table, events, deleted, s3: spy, commands, writer: sweepWriter(spy as never, "bucket", table, "refs") };
}

const run = (plan: SweepPlan, writer: SweepWriter) => executeSweep(plan, writer, () => LATER, () => {});
const stateOf = (r: Rig, n: number) => r.table.get(fileItemPk(digest(n)), "meta");

test("one file takes exactly three steps in order, and deleted is set after DeleteObject returned", async () => {
  const r = rig([condemned(1)]);
  const outcome = await run(planOf([condemned(1)], { keys: [objectKey(digest(1))] }), r.writer);
  assert.deepEqual(r.events, ["table:update", "s3:delete(deleting)", "table:update"]);
  assert.deepEqual(r.deleted, [objectKey(digest(1))]);
  assert.equal(stateOf(r, 1)!.state, "deleted");
  assert.equal(stateOf(r, 1)!.deleting_at, LATER.toISOString());
  assert.equal(outcome.swept, 1);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(r.commands[0], { Bucket: "bucket", Key: objectKey(digest(1)) }, "the current version only: no version id");
});

test("a failed DeleteObject leaves the item deleting and records a failure; nothing says deleted", async () => {
  const items = [condemned(1), condemned(2)];
  const r = rig(items, { failDelete: true });
  const outcome = await run(planOf(items, { keys: [objectKey(digest(1)), objectKey(digest(2))] }), r.writer);
  assert.equal(stateOf(r, 1)!.state, "deleting");
  assert.equal(stateOf(r, 2)!.state, "deleting");
  assert.equal(outcome.swept, 0);
  assert.deepEqual(outcome.failures.map((failure) => `${failure.digest.slice(-1)} ${failure.step} ${failure.reason}`), ["1 delete_object AccessDenied", "2 delete_object AccessDenied"]);
  assert.equal(r.table.commands.length, 2, "only the two step-1 updates; no step 3");
  assert.ok([...r.table.items.values()].every((item) => item.state !== "deleted"));
});

test("a build that revives the file before step 1 wins: the condition fails and nothing is deleted", async () => {
  const items = [condemned(1)];
  const r = rig(items);
  const plan = planOf(items, { keys: [objectKey(digest(1))] });
  const refs = new ReleaseRefs(r.table, "refs", () => LATER);
  await refs.claimFile({ gameId: "minecraft", presetId: "preset", release: "1.2" }, { sha256: digest(1), bytes: 5, path: "mods/a.jar" }, { ensureObject: async () => {}, sleep: async () => {} });
  const outcome = await run(plan, r.writer);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(r.events.filter((event) => event.startsWith("s3:")), []);
  assert.equal(outcome.skipped, 1);
  assert.equal(outcome.swept, 0);
  assert.deepEqual({ state: stateOf(r, 1)!.state, refs: stateOf(r, 1)!.refs }, { state: "live", refs: 1 });
});

test("a build that arrives after step 1 waits, then recreates the object and revives the item", async () => {
  const items = [condemned(1)];
  const r = rig(items);
  const refs = new ReleaseRefs(r.table, "refs", () => LATER);
  const ref = { gameId: "minecraft", presetId: "preset", release: "1.2" };
  const modes: string[] = [];
  let sleeps = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let claim: Promise<string> | undefined;
  const writer: SweepWriter = {
    ...r.writer,
    async markDeleting(...args) {
      const won = await r.writer.markDeleting(...args);
      claim = refs.claimFile(ref, { sha256: digest(1), bytes: 5, path: "mods/a.jar" }, {
        ensureObject: async (_file, mode) => { modes.push(mode); r.events.push(`ensure:${mode}`); },
        sleep: async () => { sleeps += 1; await released; },
      });
      return won;
    },
    async markDeleted(...args) {
      const done = await r.writer.markDeleted(...args);
      release();
      return done;
    },
  };
  const outcome = await run(planOf(items, { keys: [objectKey(digest(1))] }), writer);
  assert.equal(await claim, "recreated");
  assert.equal(outcome.swept, 1);
  assert.ok(sleeps >= 1, "the build waited while the file was deleting");
  assert.deepEqual(modes, ["recreate"]);
  assert.ok(r.events.indexOf("s3:delete(deleting)") < r.events.indexOf("ensure:recreate"), "the object is deleted first and uploaded again after");
  assert.deepEqual({ state: stateOf(r, 1)!.state, refs: stateOf(r, 1)!.refs }, { state: "live", refs: 1 });
  assert.ok(r.table.get(fileItemPk(digest(1)), "release#minecraft/preset/1.2"));
});

test("a stuck deleting item is finished, or reverted to live or condemned", async () => {
  const hoursAgo = (hours: number) => new Date(Date.parse(START) - hours * 3_600_000).toISOString();
  const stuck = (n: number, extra: Record<string, unknown> = {}): TableItem => condemned(n, { state: "deleting", deleting_at: hoursAgo(2), ...extra });
  const items = [
    stuck(1), // refs 0, unnamed: finish
    stuck(2, { deleting_at: undefined }), // no deleting_at: stuck too
    stuck(3, { refs: 2 }), // refs: back to live
    stuck(4), // refs 0 but a manifest names it: back to condemned
    stuck(5, { deleting_at: hoursAgo(0.2) }), // a run may still work on it
  ];
  const keys = [1, 2, 3, 4, 5].map((n) => objectKey(digest(n)));
  const plan = planOf(items, { keys, manifests: [manifest(R11, { storage: { layout: "objects-v1" }, server: { mods: [{ file: "a.jar", sha256: digest(4), bytes: 1 }] } })] });
  assert.deepEqual(plan.actions, [
    { kind: "finish", digest: digest(1) }, { kind: "finish", digest: digest(2) },
    { kind: "revert", digest: digest(3), to: "live" }, { kind: "revert", digest: digest(4), to: "condemned" },
  ]);
  const r = rig(items);
  const outcome = await run(plan, r.writer);
  assert.deepEqual(r.deleted, [objectKey(digest(1)), objectKey(digest(2))]);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => stateOf(r, n)!.state), ["deleted", "deleted", "live", "condemned", "deleting"]);
  assert.equal("deleting_at" in stateOf(r, 3)!, false);
  assert.equal("condemned_at" in stateOf(r, 3)!, false, "a live file is not condemned");
  assert.equal(stateOf(r, 4)!.condemned_at, OLD);
  assert.deepEqual({ swept: outcome.swept, reverted: outcome.reverted }, { swept: 2, reverted: 2 });
  assert.equal(r.table.commands.length, 4, "a finish takes step 3 only, no step 1");
});

test("an orphan with no table item is condemned with its listed size; a file the table knows or a build holds is not", async () => {
  const items = [
    { pk: fileItemPk(digest(2)), sk: "meta", refs: 1, state: "live", bytes: 3 },
    { pk: "release#minecraft/preset/1.2", sk: "meta", state: "building", layout: "objects" },
    { pk: fileItemPk(digest(3)), sk: "meta", refs: 1, state: "live", bytes: 3 },
    { pk: fileItemPk(digest(3)), sk: "release#minecraft/preset/1.2", path: "x" },
  ];
  const keys = [1, 2, 3, 4].map((n) => objectKey(digest(n)));
  const marks = mark({ manifestsListed: true, manifests: [manifest(R11, { storage: { layout: "objects-v1" }, server: { mods: [{ file: "a.jar", sha256: digest(4), bytes: 1 }] } })], worlds: [], pointers: [], archives: [], catalogs: [], retired: new Set(), failures: [] });
  const table = tableView(items);
  const listing = { keys, sizes: new Map([[keys[0]!, 1234]]) };
  const plan = planSweep({ report: compare(marks, table, listing, START, START), marks, table, listing, graceDays: 14 });
  assert.deepEqual(plan.actions, [{ kind: "condemn", digest: digest(1), bytes: 1234 }]);

  const r = rig(items);
  const outcome = await run(plan, r.writer);
  assert.deepEqual(stateOf(r, 1), { pk: fileItemPk(digest(1)), sk: "meta", state: "condemned", refs: 0, bytes: 1234, condemned_at: LATER.toISOString() });
  assert.equal(outcome.condemned, 1);
  assert.deepEqual(r.deleted, []);

  // A build created the item after the scan: the condition keeps its item.
  const raced = rig([...items, { pk: fileItemPk(digest(1)), sk: "meta", refs: 1, state: "live", bytes: 9 }]);
  const racedOutcome = await run(plan, raced.writer);
  assert.equal(racedOutcome.condemned, 0);
  assert.equal(racedOutcome.skipped, 1);
  assert.equal(stateOf(raced, 1)!.state, "live");
});

test("the writer refuses a key outside objects/sha256/", async () => {
  const r = rig([]);
  await assert.rejects(() => r.writer.deleteObject("releases/minecraft/preset/1.1/manifest.json"), /not_an_object_key/);
  assert.deepEqual(r.events, []);
});

// --- the flag ---------------------------------------------------------------

test("only the exact string false turns the dry run off", () => {
  for (const value of [undefined, "", "true", "TRUE", "False", "FALSE", "0", "no", " false", "false ", "garbage"]) {
    assert.equal(sweepDryRun(value), true, String(value));
  }
  assert.equal(sweepDryRun("false"), false);
});

test("the grace is 14 days by default, a whole number, and at least 1", () => {
  assert.equal(sweepGraceDays(undefined), 14);
  assert.equal(sweepGraceDays(""), 14);
  assert.equal(sweepGraceDays("soon"), 14);
  assert.equal(sweepGraceDays("0"), 1);
  assert.equal(sweepGraceDays("-5"), 1);
  assert.equal(sweepGraceDays("30"), 30);
  assert.equal(sweepGraceDays("2.7"), 2);
});

// --- the handler ------------------------------------------------------------

function world(items: readonly TableItem[], options: { dryRun: boolean; failures?: Set<string> }) {
  const table = new FakeRefsTable();
  for (const item of items) table.put(item);
  const keys = [1, 2, 3, 7].map((n) => objectKey(digest(n)));
  const sent: Metric[][] = [];
  const s3Commands: string[] = [];
  let writers = 0;
  const s3 = { async send(command: { input: Record<string, unknown> }) { s3Commands.push(String(command.input.Key)); return {}; } };
  const deps: ReconcilerDeps = {
    ports: {
      release: {
        async listKeys(prefix) { return prefix === "objects/sha256/" ? keys : []; },
        async listObjects(prefix) {
          if (options.failures?.has(`list:${prefix}`)) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
          return (prefix === "objects/sha256/" ? keys : []).map((key) => ({ key, size: 11 }));
        },
        async getText() { return null; },
      },
      backup: { async listVersions() { return []; }, async head() { return null; } },
      table: { async scan() { return [...table.items.values()]; } },
    },
    metrics: { async put(metrics) { sent.push([...metrics]); } },
    now: () => LATER,
    sweep: { dryRun: options.dryRun, graceDays: 14, writer: () => { writers += 1; return sweepWriter(s3 as never, "bucket", table, "refs"); } },
  };
  return { table, deps, sent, s3Commands, writers: () => writers };
}

const hoursAgo = (hours: number) => new Date(LATER.getTime() - hours * 3_600_000).toISOString();
// 1: past its grace. 2: stuck deleting. 3: live, in use. 7: an orphan (listed, no item).
const handlerItems = (): TableItem[] => [
  condemned(1),
  condemned(2, { state: "deleting", deleting_at: hoursAgo(3) }),
  { pk: fileItemPk(digest(3)), sk: "meta", refs: 1, state: "live", bytes: 4 },
  { pk: fileItemPk(digest(3)), sk: "release#minecraft/preset/1.0", path: "x" },
  { pk: "release#minecraft/preset/1.0", sk: "meta", state: "live", layout: "objects" },
];

async function quiet<T>(work: () => Promise<T>): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
  const lines: Array<Record<string, unknown>> = [];
  const info = console.info;
  console.info = (line: unknown) => { lines.push(JSON.parse(String(line)) as Record<string, unknown>); };
  try {
    return { result: await work(), lines };
  } finally {
    console.info = info;
  }
}

function values(metrics: readonly Metric[]): Record<string, number> {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

test("a dry run builds no write port, writes nothing, and logs one line per would-be action", async () => {
  const w = world(handlerItems(), { dryRun: true });
  const before = structuredClone([...w.table.items.entries()]);
  const { result, lines } = await quiet(() => reconcile({}, w.deps));
  assert.equal(w.writers(), 0, "the writer factory was never called");
  assert.deepEqual(w.table.commands, []);
  assert.deepEqual(w.s3Commands, []);
  assert.deepEqual([...w.table.items.entries()], before);
  const actions = lines.filter((line) => line.event === "release_sweep_action");
  assert.deepEqual(actions.map((line) => `${String(line.kind)} ${String(line.digest).slice(-1)} ${String(line.dryRun)}`), ["finish 2 true", "delete 1 true", "condemn 7 true"]);
  assert.deepEqual(values(w.sent[0]!), {
    DangerousDiff: 0, MissingObject: 0, RunFailed: 0, OrphanObjects: 4, ExtraReferences: 1, CounterDrift: 0, UnregisteredReleases: 0, Incomplete: 0,
    SweepCandidates: 2, SweptObjects: 0, SweepFailed: 0, OrphansCondemned: 0, SweepDryRun: 1,
  });
  assert.deepEqual({ dryRun: result.sweep.dryRun, candidates: result.sweep.candidates, swept: result.sweep.swept }, { dryRun: true, candidates: 2, swept: 0 });
  assert.equal(describeSweep({ reason: null, cutoff: START, actions: [] }).length, 0);
});

test("a real run deletes, finishes, condemns the orphan and puts the metrics", async () => {
  const w = world(handlerItems(), { dryRun: false });
  const { result } = await quiet(() => reconcile({ mode: "report" }, w.deps));
  assert.equal(w.writers(), 1);
  assert.deepEqual(w.s3Commands, [objectKey(digest(2)), objectKey(digest(1))]);
  const states = [1, 2, 3, 7].map((n) => w.table.get(fileItemPk(digest(n)), "meta")?.state);
  assert.deepEqual(states, ["deleted", "deleted", "live", "condemned"]);
  assert.equal(w.table.get(fileItemPk(digest(7)), "meta")?.bytes, 11);
  assert.deepEqual(values(w.sent[0]!), {
    DangerousDiff: 0, MissingObject: 0, RunFailed: 0, OrphanObjects: 4, ExtraReferences: 1, CounterDrift: 0, UnregisteredReleases: 0, Incomplete: 0,
    SweepCandidates: 2, SweptObjects: 2, SweepFailed: 0, OrphansCondemned: 1, SweepDryRun: 0,
  });
  assert.equal(result.sweep.dryRun, false);
});

test("a run that could not read a source sweeps nothing even with the flag off", async () => {
  const w = world(handlerItems(), { dryRun: false, failures: new Set(["list:objects/sha256/"]) });
  const { result } = await quiet(() => reconcile({}, w.deps));
  assert.equal(result.sweep.reason, "incomplete_run");
  assert.equal(w.writers(), 0, "an empty plan builds no writer");
  assert.deepEqual(w.table.commands, []);
  assert.deepEqual(w.s3Commands, []);
  assert.deepEqual(
    { SweepCandidates: 0, SweepFailed: 0, OrphansCondemned: 0, SweepDryRun: 0, Incomplete: 1 },
    { ...Object.fromEntries(Object.entries(values(w.sent[0]!)).filter(([name]) => ["SweepCandidates", "SweepFailed", "OrphansCondemned", "SweepDryRun", "Incomplete"].includes(name))) },
  );
});

test("a failed DeleteObject in a real run counts as SweepFailed and the run goes on", async () => {
  const w = world([condemned(1), condemned(2)], { dryRun: false });
  let calls = 0;
  const base = w.deps.sweep.writer;
  const failing: ReconcilerDeps = {
    ...w.deps,
    sweep: { ...w.deps.sweep, writer: () => ({ ...base(), async deleteObject() { calls += 1; if (calls === 1) throw Object.assign(new Error("x"), { name: "SlowDown" }); } }) },
  };
  const { result } = await quiet(() => reconcile({}, failing));
  assert.equal(result.sweep.failed, 1);
  assert.equal(result.sweep.swept, 1);
  assert.deepEqual([1, 2].map((n) => w.table.get(fileItemPk(digest(n)), "meta")?.state), ["deleting", "deleted"]);
  assert.equal(values(w.sent[0]!).SweepFailed, 1);
});

test("the sweep metrics are named for the alarm", () => {
  assert.deepEqual(sweepMetrics({ dryRun: true, graceDays: 14, reason: null, candidates: 3, swept: 0, failed: 0, orphansCondemned: 0 }).map((metric) => metric.name),
    ["SweepCandidates", "SweptObjects", "SweepFailed", "OrphansCondemned", "SweepDryRun"]);
});
