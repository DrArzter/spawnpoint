import "./support/browser.ts";

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import type { OperationProgress } from "../src/api/contract.ts";
import type { OperationProgressModel } from "../src/core/models.ts";
import { endedBadly, MAX_FAILURES, MAX_POLLS, newestRunning, owesFinalRead, POLL_MS, progressDetails, progressModel, startPolling } from "../src/core/operation-progress.ts";
import type { Operation } from "../src/model.ts";

/*
 * What the world page tells of a running operation: which one it follows,
 * how it reads it, when it stops reading, and what it keeps once the
 * operation failed.
 */

const START = Date.parse("2026-11-21T12:00:00.000Z");
const startedAt = new Date(START).toISOString();
const at = (seconds: number) => START + seconds * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const operation = (id: string, worldId: string | null, started = startedAt, type: Operation["type"] = "promote"): Operation => ({ id, type, status: "running", startedAt: started, worldId, expectedSeconds: 60, expectedSamples: 4 });

const running: OperationProgress = {
  id: "op-1", type: "promote", status: "running", startedAt, stoppedAt: null, elapsedSeconds: 12, expectedSeconds: 60, expectedSamples: 4,
  step: { key: "promote.starting_release", label: "Starting on the new release" },
  child: { type: "start", step: { key: "start.waiting_host", label: "Waiting for the host" } },
  result: null, failure: null, caught: null,
};
const failed: OperationProgress = {
  ...running, status: "failed", stoppedAt: new Date(at(30)).toISOString(), elapsedSeconds: 30, step: null, child: null,
  failure: { error: "Ec2.InsufficientInstanceCapacity", cause: "No capacity in eu-central-1a." },
  caught: { error: "SessionStartFailed", cause: "The host never reported ready.", step: { key: "promote.starting_release", label: "Starting on the new release" } },
};

afterEach(() => { mock.timers.reset(); });

test("the newest running operation that names this world is the one followed", () => {
  const operations = [operation("old", "w1", startedAt), operation("new", "w1", new Date(at(20)).toISOString()), operation("other", "w2", new Date(at(90)).toISOString()), operation("anon", null, new Date(at(99)).toISOString())];
  assert.equal(newestRunning(operations, "w1")?.id, "new");
  assert.equal(newestRunning(operations, "w3"), null);
});

test("a running operation shows at once from the snapshot, then with the step the API reports", () => {
  const first = progressModel(operation("op-1", "w1"), null)!;
  assert.deepEqual([first.status, first.running, first.step, first.child, first.title], [{ kind: "progress", label: "Running" }, true, null, null, "Promoting release"]);
  assert.deepEqual(first.expectation, { expectedSeconds: 60, expectedSamples: 4 });
  const next = progressModel(operation("op-1", "w1"), running)!;
  assert.deepEqual([next.step, next.child], ["Starting on the new release", "Waiting for the host"]);
  // A read of an earlier operation says nothing of this one.
  assert.equal(progressModel(operation("op-2", "w1"), running)!.step, null);
});

test("an operation that ended badly stays on the page with its cause, and one that succeeded leaves nothing", () => {
  const kept = progressModel(null, failed)!;
  assert.deepEqual([kept.status, kept.running, kept.ranSeconds], [{ kind: "error", label: "Failed" }, false, 30]);
  assert.deepEqual(kept.failure, { error: "Ec2.InsufficientInstanceCapacity", cause: "No capacity in eu-central-1a." });
  assert.deepEqual(kept.caught, { error: "SessionStartFailed", cause: "The host never reported ready.", step: "Starting on the new release" });
  assert.equal(progressModel(null, { ...running, status: "succeeded", result: "promoted", step: null, child: null }), null);
  assert.equal(progressModel(null, running), null);
  for (const [status, label] of [["timed_out", "Timed out"], ["aborted", "Aborted"]] as const) assert.equal(progressModel(null, { ...failed, status })!.status.label, label);
});

test("a rolled back promotion that caught an error is kept as a warning", () => {
  const rolledBack: OperationProgress = { ...failed, status: "succeeded", result: "rolled_back", failure: null };
  assert.ok(endedBadly(rolledBack));
  assert.deepEqual(progressModel(null, rolledBack)!.status, { kind: "warning", label: "Rolled back" });
  assert.ok(!endedBadly({ ...rolledBack, caught: null }));
});

test("the rows tick from the start time, with the ETA of the flashbar and the usual time as its tip", () => {
  const model = progressModel(operation("op-1", "w1"), running)!;
  const rows = (seconds: number) => Object.fromEntries(progressDetails(model, at(seconds)).map((row) => [row.label, row]));
  assert.deepEqual(Object.keys(rows(5)), ["Step", "Sub-step", "Elapsed", "Expected"]);
  assert.deepEqual(rows(5).Elapsed!.value, { type: "text", text: "0:05", mono: true });
  assert.deepEqual(rows(42).Elapsed!.value, { type: "text", text: "0:42", mono: true });
  assert.deepEqual(rows(42).Expected!.value, { type: "text", text: "ETA ~0:18", mono: true });
  assert.equal(rows(42).Expected!.explain, "Usually 1:00, from the last 4 runs");
  assert.deepEqual(rows(90).Expected!.value, { type: "text", text: "Taking longer", mono: true });
});

test("without a step or history the rows are the elapsed time alone", () => {
  const model = progressModel({ ...operation("op-1", "w1"), expectedSeconds: undefined }, null)!;
  assert.deepEqual(progressDetails(model, at(3)).map((row) => row.label), ["Elapsed"]);
});

test("a failure shows the workflow's own error and cause whole, then what it caught and where", () => {
  const rows = progressDetails(progressModel(null, failed)!, at(500));
  assert.deepEqual(rows.map((row) => row.label), ["Elapsed", "Error", "Cause", "Caught", "Caught cause", "Caught at"]);
  assert.deepEqual(rows[0]!.value, { type: "text", text: "0:30", mono: true });
  assert.deepEqual(rows[1]!.value, { type: "text", text: "Ec2.InsufficientInstanceCapacity", mono: true, wrap: true });
  assert.deepEqual(rows[2]!.value, { type: "text", text: "No capacity in eu-central-1a.", wrap: true });
  assert.deepEqual(rows[5]!.value, { type: "text", text: "Starting on the new release" });
});

// --- polling -------------------------------------------------------------------

function poll(answers: (() => Promise<OperationProgress | null>)[], visible = () => true) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const seen: OperationProgress[] = [];
  let reads = 0;
  const read = () => { const answer = answers[Math.min(reads, answers.length - 1)]!; reads += 1; return answer(); };
  const poller = startPolling({ read, onProgress: (progress) => seen.push(progress), visible });
  return { poller, seen, reads: () => reads };
}

const ok = (progress: OperationProgress = running) => () => Promise.resolve(progress);
const bad = () => Promise.reject(new Error("offline"));

async function after(ms: number) {
  mock.timers.tick(ms);
  await flush();
}

test("it reads at once, then every four seconds while the operation runs", async () => {
  const { poller, seen, reads } = poll([ok()]);
  await flush();
  assert.equal(reads(), 1);
  await after(POLL_MS - 1);
  assert.equal(reads(), 1);
  await after(1);
  assert.equal(reads(), 2);
  await after(POLL_MS);
  assert.equal(reads(), 3);
  assert.equal(seen.length, 3);
  poller.stop();
  await after(POLL_MS * 3);
  assert.equal(reads(), 3);
});

test("it stops reading once the operation is no longer running", async () => {
  const { seen, reads } = poll([ok(), ok(failed)]);
  await flush();
  await after(POLL_MS);
  assert.equal(seen.at(-1)!.status, "failed");
  await after(POLL_MS * 5);
  assert.equal(reads(), 2);
});

test("it holds no read while the page is hidden and reads at once when it shows again", async () => {
  let shown = true;
  const { poller, reads } = poll([ok()], () => shown);
  await flush();
  shown = false;
  poller.hide();
  await after(POLL_MS * 5);
  assert.equal(reads(), 1);
  shown = true;
  poller.show();
  await flush();
  assert.equal(reads(), 2);
  await after(POLL_MS);
  assert.equal(reads(), 3);
  poller.stop();
});

test("a failed read keeps the last good value and tries again; three in a row end it", async () => {
  const { seen, reads } = poll([ok(), bad, ok(), bad, bad, bad, ok()]);
  await flush();
  for (let index = 0; index < 8; index += 1) await after(POLL_MS);
  // The good, the failure and the good that follows reset the count; the three that follow end it.
  assert.equal(reads(), 6);
  assert.equal(seen.length, 2);
  assert.equal(MAX_FAILURES, 3);
});

test("a read that finds no operation counts as a failure", async () => {
  const { seen, reads } = poll([() => Promise.resolve(null)]);
  await flush();
  for (let index = 0; index < 6; index += 1) await after(POLL_MS);
  assert.equal(reads(), 3);
  assert.equal(seen.length, 0);
});

test("polling is bounded", async () => {
  const { reads } = poll([ok()]);
  await flush();
  for (let index = 0; index < MAX_POLLS + 20; index += 1) await after(POLL_MS);
  assert.equal(reads(), MAX_POLLS);
});

test("a last read is owed when the operation left the snapshot, unless a poll saw it end", () => {
  assert.ok(owesFinalRead("op-1", null));
  assert.ok(owesFinalRead("op-1", running));
  assert.ok(owesFinalRead("op-1", { ...failed, id: "op-0" }));
  assert.ok(!owesFinalRead("op-1", failed));
  assert.ok(!owesFinalRead(null, null));
});

test("the model carries nothing a skin has to compute", () => {
  const model: OperationProgressModel = progressModel(null, failed)!;
  assert.deepEqual(Object.keys(model).sort(), ["caught", "child", "expectation", "failure", "id", "log", "ranSeconds", "running", "startedAt", "status", "step", "title"]);
});
