import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DescribeExecutionCommand, ListExecutionsCommand, type SFNClient } from "@aws-sdk/client-sfn";
import { type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { closeSessionHost, openSessionHost, pruneSessionHistory, type SessionHost } from "../src/domain/session-history.ts";
import { createSessionHistoryCoordinator, type SessionHistoryStore } from "../src/lifecycle/session-history.ts";
import { createSessionHostReader, sessionHostsFromExecutions } from "../src/control-plane/aws-session-history.ts";
import { joinSampledSeries, mergeWorldMetrics, worldHostRuns, type HostRun } from "../src/control-plane/world-metrics.ts";
import type { HostMetricsWindow } from "../src/control-plane/read-model.ts";

const T0 = Date.UTC(2026, 10, 21, 12, 0);
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

// --- the stored history ----------------------------------------------------

test("a session opens on its host, and a stop that was never recorded ends when the next session starts", () => {
  const first = openSessionHost([], { sessionId: "s1", hostId: "i-aaaa1111" }, at(0));
  assert.deepEqual(first, [{ sessionId: "s1", hostId: "i-aaaa1111", startedAt: iso(0), endedAt: null }]);
  const second = openSessionHost(first, { sessionId: "s2", hostId: "i-bbbb2222" }, at(90));
  assert.equal(second[0]?.endedAt, iso(90));
  assert.equal(second[1]?.endedAt, null);
});

test("a retried open keeps the first start, and a close is idempotent", () => {
  const opened = openSessionHost([], { sessionId: "s1", hostId: "i-aaaa1111" }, at(0));
  const retried = openSessionHost(opened, { sessionId: "s1", hostId: "i-aaaa1111" }, at(5));
  assert.equal(retried[0]?.startedAt, iso(0));
  const closed = closeSessionHost(retried, "s1", at(60));
  assert.equal(closed[0]?.endedAt, iso(60));
  assert.equal(closeSessionHost(closed, "s1", at(120))[0]?.endedAt, iso(60), "the first stop stands");
  assert.deepEqual(closeSessionHost(closed, "unknown", at(120)), closed);
});

test("history is bounded: entries that ended before the retention window are dropped, a running one stays", () => {
  const old = { sessionId: "old", hostId: "i-aaaa1111", startedAt: iso(-60 * 24 * 10), endedAt: iso(-60 * 24 * 9) };
  const open = { sessionId: "open", hostId: "i-bbbb2222", startedAt: iso(-60 * 24 * 10), endedAt: null };
  assert.deepEqual(pruneSessionHistory([old, open], at(0)).map((entry) => entry.sessionId), ["open"]);
});

test("the coordinator keeps one item per world, creates it on the first open and ignores a close without one", async () => {
  const items = new Map<string, { revision: number; entries: readonly SessionHost[] }>();
  let conflicts = 1;
  const store: SessionHistoryStore = {
    read: async (worldId) => items.get(worldId) ?? null,
    create: async (worldId, entries) => { if (items.has(worldId)) return false; items.set(worldId, { revision: 1, entries }); return true; },
    compareAndSet: async (worldId, revision, entries) => {
      if (conflicts-- > 0) return false;
      items.set(worldId, { revision: revision + 1, entries });
      return true;
    },
  };
  const run = createSessionHistoryCoordinator(store, () => at(0));
  assert.deepEqual(await run({ action: "closeSessionHistory", worldId: "w", sessionId: "s1" }), { entries: 0 });
  assert.equal(items.size, 0);
  await run({ action: "openSessionHistory", worldId: "w", sessionId: "s1", hostId: "i-aaaa1111" });
  await run({ action: "closeSessionHistory", worldId: "w", sessionId: "s1" });
  assert.equal(items.get("w")?.entries[0]?.endedAt, iso(0));
  assert.equal(items.get("w")?.revision, 2, "a lost race is retried");
  await assert.rejects(run({ action: "openSessionHistory", worldId: "w", sessionId: "s2", hostId: "" }), /hostId/);
});

// --- the workflows write it ----------------------------------------------------

type Definition = { States: Record<string, { Next?: string; Parameters?: { Payload?: Record<string, unknown> }; Catch?: { Next: string }[] }> };

async function definition(name: string): Promise<Definition> {
  const template = await readFile(new URL(`../../workflows/${name}.asl.json.tftpl`, import.meta.url), "utf8");
  return JSON.parse(template.replaceAll("${allowed_instance_types}", "[]").replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource")) as Definition;
}

test("a start records its host once the session is ready, and a failure to record does not fail the start", async () => {
  const { States } = await definition("start-server-v2");
  assert.equal(States["Mark Session Ready"]?.Next, "Record Session Host");
  const record = States["Record Session Host"]!;
  assert.equal(record.Next, "Route Release Commit");
  assert.deepEqual(record.Catch?.map((caught) => caught.Next), ["Route Release Commit"]);
  assert.deepEqual(record.Parameters?.Payload, { action: "openSessionHistory", "worldId.$": "$.request.worldId", "sessionId.$": "$.request.sessionId", "hostId.$": "$.request.placed.hostId" });
  assert.equal(States["Mark Compensated Session Stopped"]?.Next, "Close Compensated Session History");
  assert.equal(States["Mark Forced Session Stopped"]?.Next, "Close Forced Session History");
});

test("a stop closes the session's history after it is marked stopped", async () => {
  const { States } = await definition("stop-server-v2");
  assert.equal(States["Mark Session Stopped"]?.Next, "Close Session History");
  assert.equal(States["Close Session History"]?.Next, "Release Placement");
  assert.deepEqual(States["Close Session History"]?.Catch?.map((caught) => caught.Next), ["Release Placement"]);
  assert.equal(States["Close Session History"]?.Parameters?.Payload?.action, "closeSessionHistory");
});

// --- sessions from the finished workflows -------------------------------------------

const startOf = (world: string, session: string, host: string, minute: number) => ({
  stopDate: at(minute),
  input: { worldId: world, serverId: world, instanceId: "i-configured1" },
  output: { sessionId: session, status: "ready", hostStart: { instanceId: host } },
});
const stopOf = (session: string, minute: number, status = "stopped") => ({ stopDate: at(minute), output: { sessionId: session, status } });

test("a finished start names the world, session and host, and the stop of that session ends it", () => {
  const entries = sessionHostsFromExecutions("w",
    [startOf("w", "s1", "i-aaaa1111", 5), startOf("other", "s9", "i-cccc3333", 6), startOf("w", "s2", "i-bbbb2222", 200)],
    [stopOf("s1", 120), stopOf("s2", 300, "already_stopped")]);
  assert.deepEqual(entries, [
    { sessionId: "s1", hostId: "i-aaaa1111", startedAt: iso(5), endedAt: iso(120) },
    { sessionId: "s2", hostId: "i-bbbb2222", startedAt: iso(200), endedAt: null },
  ]);
});

function fakeWorkflows(options: Readonly<{ stored?: SessionHost[]; failList?: boolean }> = {}) {
  const calls = { list: 0, describe: 0 };
  const executions: Record<string, { stopDate: Date; input?: unknown; output: unknown }> = {
    "arn:start:1": startOf("w", "s1", "i-aaaa1111", 5),
    "arn:stop:1": stopOf("s1", 120),
  };
  const sfn = { send: async (command: unknown) => {
    if (command instanceof ListExecutionsCommand) {
      calls.list += 1;
      if (options.failList) throw new Error("denied");
      const kind = command.input.stateMachineArn === "arn:machine:start" ? "start" : "stop";
      return { executions: [{ executionArn: `arn:${kind}:1`, stopDate: executions[`arn:${kind}:1`]!.stopDate }] };
    }
    if (command instanceof DescribeExecutionCommand) {
      calls.describe += 1;
      const found = executions[command.input.executionArn!]!;
      return { input: JSON.stringify(found.input ?? {}), output: JSON.stringify(found.output) };
    }
    throw new Error("unexpected command");
  } } as unknown as SFNClient;
  const document = { send: async () => ({ Item: options.stored ? { entries: options.stored } : undefined }) } as unknown as DynamoDBDocumentClient;
  const read = createSessionHostReader({
    sfn, document, tableName: () => "lifecycle", now: () => T0,
    machines: () => [{ type: "start", arn: "arn:machine:start" }, { type: "stop", arn: "arn:machine:stop" }],
  });
  return { read, calls };
}

test("before the stored history begins, the finished workflows fill the window; each execution is described once", async () => {
  const { read, calls } = fakeWorkflows();
  const since = T0 - 6 * 3_600_000;
  assert.deepEqual(await read("w", since), [{ sessionId: "s1", hostId: "i-aaaa1111", startedAt: iso(5), endedAt: iso(120) }]);
  const described = calls.describe;
  await read("w", since);
  assert.equal(calls.describe, described);
});

test("the stored history is used alone when it reaches back to the window", async () => {
  const stored = [{ sessionId: "s0", hostId: "i-bbbb2222", startedAt: iso(-600), endedAt: iso(-500) }];
  const { read, calls } = fakeWorkflows({ stored });
  assert.deepEqual(await read("w", T0 - 6 * 3_600_000), stored);
  assert.equal(calls.list, 0, "no workflow is listed");
});

test("the workflows fill only what the stored history does not have, and a failed read leaves the stored history", async () => {
  const stored = [{ sessionId: "s2", hostId: "i-bbbb2222", startedAt: iso(300), endedAt: null }];
  const filled = await fakeWorkflows({ stored }).read("w", T0 - 6 * 3_600_000);
  assert.deepEqual(filled.map((entry) => entry.sessionId), ["s1", "s2"]);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(await fakeWorkflows({ stored, failList: true }).read("w", T0 - 6 * 3_600_000), stored);
  } finally {
    console.warn = warn;
  }
});

// --- merging hosts -------------------------------------------------------------

const SLOTS = 24;
const PERIOD = 300;
const grid = Array.from({ length: SLOTS }, (_, index) => iso(index * 5));

// `shape` gives each reading its host's capacity, as the EC2 adapter does.
function host(values: Readonly<{ cpu?: (number | null)[]; memory?: (number | null)[] }>, shape?: Readonly<{ cores: number; bytes: number }>): HostMetricsWindow {
  const series = (id: string, label: string, unit: string, list: (number | null)[] | undefined, capacity?: number) => ({
    id, label, unit, points: grid.map((slot, index) => {
      const value = list?.[index] ?? null;
      return value !== null && capacity !== undefined ? { at: slot, value, capacity } : { at: slot, value };
    }),
  });
  return {
    startedAt: grid[0]!, endedAt: iso(SLOTS * 5), periodSeconds: PERIOD,
    series: [
      { ...series("cpu", "CPU", "percent", values.cpu, shape?.cores), capacityUnit: "cores" as const },
      { ...series("memory", "Memory", "percent", values.memory, shape?.bytes), capacityUnit: "bytes" as const },
      series("networkIn", "Network in", "bytesPerSecond", values.cpu),
    ],
  };
}
const fill = (from: number, to: number, value: number): (number | null)[] => Array.from({ length: SLOTS }, (_, index) => index >= from && index < to ? value : null);
const run = (hostId: string, from: number, to: number | null): HostRun => ({ hostId, startedAtMs: T0 + from * 5 * 60_000, endedAtMs: to === null ? null : T0 + to * 5 * 60_000 });
const valuesOf = (metrics: HostMetricsWindow | null, id: string) => metrics?.series.find((series) => series.id === id)?.points.map((point) => point.value);

test("each slot takes the reading of the host that ran the world then; two hosts are never added", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(2, 8, 10) }), "i-bbbb2222": host({ cpu: fill(12, 18, 40) }) },
    [run("i-aaaa1111", 2, 8), run("i-bbbb2222", 12, 18)],
  );
  const cpu = valuesOf(merged, "cpu")!;
  assert.deepEqual(cpu.slice(0, 20), [...Array(2).fill(null), ...Array(6).fill(10), ...Array(4).fill(null), ...Array(6).fill(40), null, null]);
  assert.equal(merged?.pendingFrom, undefined, "no session runs, nothing is pending");
});

test("a host's own readings outside its run are left out, and an overlapping slot goes to the run that covers more of it", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 12, 10) }), "i-bbbb2222": host({ cpu: fill(5, 12, 40) }) },
    [run("i-aaaa1111", 0, 5.2), run("i-bbbb2222", 5.2, 10)],
  );
  const cpu = valuesOf(merged, "cpu")!;
  assert.equal(cpu[4], 10);
  assert.equal(cpu[5], 40, "the second run covers most of slot 5");
  assert.equal(cpu[9], 40);
  assert.equal(cpu[10], null, "after the last run the host's idle readings do not count");
});

const SMALL = { cores: 2, bytes: 8 * 1024 ** 3 };
const LARGE = { cores: 4, bytes: 32 * 1024 ** 3 };
const capacitiesOf = (metrics: HostMetricsWindow | null, id: string) => metrics?.series.find((series) => series.id === id)?.points.map((point) => point.capacity);

test("each slot carries the capacity of the host that gave its reading", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 4, 10), memory: fill(0, 4, 50) }, SMALL), "i-bbbb2222": host({ cpu: fill(6, 10, 40), memory: fill(6, 10, 25) }, LARGE) },
    [run("i-aaaa1111", 0, 4), run("i-bbbb2222", 6, 10)],
  );
  assert.deepEqual(capacitiesOf(merged, "cpu")?.slice(0, 10), [2, 2, 2, 2, undefined, undefined, 4, 4, 4, 4]);
  assert.deepEqual(capacitiesOf(merged, "memory")?.slice(3, 7), [SMALL.bytes, undefined, undefined, LARGE.bytes]);
  assert.equal(merged?.series.find((series) => series.id === "cpu")?.capacityUnit, "cores");
  assert.equal(merged?.series.find((series) => series.id === "memory")?.capacityUnit, "bytes");
  assert.equal(merged?.series.find((series) => series.id === "networkIn")?.capacityUnit, undefined);
});

test("a slot whose host has no known shape has no capacity", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 4, 10) }), "i-bbbb2222": host({ cpu: fill(4, 8, 40) }, LARGE) },
    [run("i-aaaa1111", 0, 4), run("i-bbbb2222", 4, 8)],
  );
  const cpu = merged?.series.find((series) => series.id === "cpu")?.points ?? [];
  assert.deepEqual(cpu[1], { at: grid[1], value: 10 }, "no capacity key at all");
  assert.equal(cpu[5]?.capacity, 4);
});

// --- memory ---------------------------------------------------------------------

function owned(values: (number | null)[], hostIds: (string | null)[] = []) {
  return values.map((value, index) => ({ point: { at: grid[index]!, value }, hostId: hostIds[index] ?? (value === null ? null : "i-aaaa1111") }));
}
const running = owned(Array(SLOTS).fill(5), Array(SLOTS).fill("i-aaaa1111"));

test("memory readings one probe apart are joined with a line, flagged as interpolated", () => {
  const joined = joinSampledSeries(owned([40, null, null, 70, null, null, 70]), running, PERIOD);
  assert.deepEqual(joined.map((point) => point.value), [40, 50, 60, 70, 70, 70, 70]);
  assert.deepEqual(joined.map((point) => point.interpolated === true), [false, true, true, false, true, true, false]);
});

test("memory is not joined over a longer stretch, across hosts, or over a slot without CPU", () => {
  assert.ok(joinSampledSeries(owned([40, null, null, null, null, 70]), running, PERIOD).slice(1, 5).every((point) => point.value === null), "five slots apart is 25 minutes");
  assert.equal(joinSampledSeries(owned([40, null, null, 70], ["i-aaaa1111", null, null, "i-bbbb2222"]), running, PERIOD)[1]?.value, null);
  const stopped = owned([5, 5, null, 5, 5, 5, 5], Array(7).fill("i-aaaa1111"));
  assert.equal(joinSampledSeries(owned([40, null, null, 70]), stopped, PERIOD)[1]?.value, null, "the host did not report in slot 2");
  assert.equal(joinSampledSeries(owned([40, null, null, 70]), stopped.map((slot, index) => index === 2 ? slot : slot), PERIOD)[2]?.value, null);
});

test("only memory is joined: CPU and network keep their gaps", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 12, 10).map((value, index) => index % 3 === 0 ? value : null), memory: fill(0, 12, 50).map((value, index) => index % 3 === 0 ? value : null) }) },
    [run("i-aaaa1111", 0, 12)],
  );
  assert.deepEqual(valuesOf(merged, "cpu")?.slice(0, 4), [10, null, null, 10]);
  assert.equal(valuesOf(merged, "networkIn")?.[1], null);
  assert.equal(valuesOf(merged, "memory")?.[1], null, "CPU was missing in those slots, so the host cannot be said to have run");
});

test("a joined memory point carries the capacity of the host that owns it", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 4, 10), memory: [50, null, null, 50] }, SMALL), "i-bbbb2222": host({ cpu: fill(4, 10, 10), memory: [null, null, null, null, 20, null, null, 40] }, LARGE) },
    [run("i-aaaa1111", 0, 4), run("i-bbbb2222", 4, 10)],
  );
  const memory = merged?.series.find((series) => series.id === "memory")?.points ?? [];
  assert.deepEqual(memory.slice(0, 4).map((point) => point.capacity), Array(4).fill(SMALL.bytes));
  assert.deepEqual(memory.slice(4, 8).map((point) => [point.value, point.interpolated === true, point.capacity]), [
    [20, false, LARGE.bytes], [26.67, true, LARGE.bytes], [33.33, true, LARGE.bytes], [40, false, LARGE.bytes],
  ]);
});

test("memory across two hosts is joined within one host only", () => {
  const merged = mergeWorldMetrics(
    { "i-aaaa1111": host({ cpu: fill(0, 6, 10), memory: [50, null, null, 50] }), "i-bbbb2222": host({ cpu: fill(6, 12, 10), memory: fill(0, 0, 0) }) },
    [run("i-aaaa1111", 0, 6), run("i-bbbb2222", 6, 12)],
  );
  assert.deepEqual(valuesOf(merged, "memory")?.slice(0, 6), [50, 50, 50, 50, null, null]);
});

// --- the right edge ----------------------------------------------------------------

test("while the session runs, the slots after the newest reading are pending, not off", () => {
  const merged = mergeWorldMetrics({ "i-aaaa1111": host({ cpu: fill(0, 20, 10), memory: fill(17, 18, 50).map((value, index) => index === 17 ? value : index === 20 ? 52 : null) }) }, [run("i-aaaa1111", 0, null)]);
  assert.equal(merged?.pendingFrom, iso(20 * 5), "the first slot with no reading");
  assert.equal(merged?.series.find((series) => series.id === "cpu")?.pendingFrom, iso(100));
  assert.equal(merged?.series.find((series) => series.id === "memory")?.pendingFrom, iso(105), "memory waits for the next probe from its own last reading");
});

test("a stretch with no readings from before the last reading stays a gap; one older than half an hour is a gap again", () => {
  const cpu = fill(0, 20, 10).map((value, index) => index >= 8 && index < 12 ? null : value);
  const merged = mergeWorldMetrics({ "i-aaaa1111": host({ cpu }) }, [run("i-aaaa1111", 0, null)]);
  assert.equal(merged?.pendingFrom, iso(100), "the hole in the middle is before it");
  const stale = mergeWorldMetrics({ "i-aaaa1111": host({ cpu: fill(0, 6, 10) }) }, [run("i-aaaa1111", 0, null)]);
  assert.equal(stale?.pendingFrom, iso((SLOTS - 6) * 5), "six slots at most, so a long silence is not hidden");
});

test("a session that has just begun is pending from its first slot", () => {
  const merged = mergeWorldMetrics({ "i-aaaa1111": host({}) }, [run("i-aaaa1111", 21, null)]);
  assert.equal(merged?.pendingFrom, iso(105));
});

// --- the runs of a world ------------------------------------------------------------------

test("the live session runs to now on the live host; a stop that was never seen ends at the record's last change", () => {
  const entries: SessionHost[] = [
    { sessionId: "s1", hostId: "i-aaaa1111", startedAt: iso(0), endedAt: iso(60) },
    { sessionId: "s2", hostId: "i-bbbb2222", startedAt: iso(100), endedAt: null },
    { sessionId: "s3", hostId: "i-cccc3333", startedAt: iso(200), endedAt: null },
  ];
  const options = { windowStartMs: T0, nowMs: T0 + 600 * 60_000, unseenStopMs: T0 + 150 * 60_000 };
  const stopped = worldHostRuns(entries.slice(0, 2), null, options);
  assert.deepEqual(stopped.map((item) => [item.hostId, item.endedAtMs]), [["i-aaaa1111", T0 + 3_600_000], ["i-bbbb2222", T0 + 9_000_000]]);
  const live = worldHostRuns(entries, { hostId: "i-cccc3333", sessionId: "s3", startedAtMs: 0 }, options);
  assert.equal(live.at(-1)?.endedAtMs, null);
  assert.equal(live.at(-1)?.startedAtMs, Date.parse(iso(200)));
  const unknown = worldHostRuns([], { hostId: "i-dddd4444", sessionId: "s4", startedAtMs: T0 + 5 }, options);
  assert.deepEqual(unknown, [{ hostId: "i-dddd4444", startedAtMs: T0 + 5, endedAtMs: null }]);
  assert.deepEqual(worldHostRuns([entries[0]!], null, { ...options, windowStartMs: T0 + 2 * 3_600_000 }), [], "a session that ended before the window is not in it");
});
