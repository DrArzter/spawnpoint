import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createCommandLogReader, createOperationProgressReader } from "../src/control-plane/aws-operation-progress.ts";
import { observationOfRecord, progressOfRecord, runningOperations, type OperationRecordStore } from "../src/control-plane/operation-record-progress.ts";
import { operationRecordKey, parseOperationRecord, type OperationRecord } from "../src/control-plane/operation-record.ts";

const NOW = new Date("2026-11-27T12:10:00.000Z");
const PROMOTE = "panel-promote-20261127T120000-aaaa1111";
const START = `${PROMOTE}-target-start`;
const HOST = `${PROMOTE}-target-start-host-start`;
const INSTANCE = "i-0123456789abcdef0";
const COMMAND = "0b6f1c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";

// Records as the workflows store them, read back through the real parser.
function record(id: string, fields: Record<string, unknown>): OperationRecord {
  const parsed = parseOperationRecord({
    ...operationRecordKey(id),
    operation_id: id,
    execution_arn: `arn:aws:states:eu-central-1:123456789012:execution:m:${id}`,
    status: "running",
    world_id: "prominence",
    started_at: "2026-11-27T12:00:00.000Z",
    ...fields,
  });
  assert.ok(parsed, id);
  return parsed;
}

function store(...records: OperationRecord[]): OperationRecordStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async (id) => { reads.push(id); return records.find((candidate) => candidate.operationId === id) ?? null; },
    listOpen: async () => records.filter((candidate) => candidate.status === "running"),
  };
}

const promote = (fields: Record<string, unknown> = {}) => record(PROMOTE, { type: "promote", workflow: "promote", step: "promote.starting_release", child_id: START, ...fields });
const start = (fields: Record<string, unknown> = {}) => record(START, { type: "start", workflow: "start", parent_id: PROMOTE, root_id: PROMOTE, step: "start.starting_server", child_id: HOST, ...fields });
const host = (fields: Record<string, unknown> = {}) => record(HOST, { type: "start", workflow: "start-host", parent_id: START, root_id: PROMOTE, step: "start.waiting_host", ...fields });

test("a running operation shows its own step and the step of its deepest running nested run", async () => {
  const progress = await progressOfRecord(store(promote(), start(), host()), promote(), { now: NOW });
  assert.equal(progress.status, "running");
  assert.deepEqual(progress.step, { key: "promote.starting_release", label: "Starting on the new release" });
  assert.deepEqual(progress.child, { type: "start", step: { key: "start.waiting_host", label: "Waiting for the host" } });
  assert.equal(progress.elapsedSeconds, 600);
  assert.equal(progress.stoppedAt, null);
});

test("an ended nested run is not shown, and the next one up is", async () => {
  const progress = await progressOfRecord(store(promote(), start(), host({ status: "succeeded" })), promote(), { now: NOW });
  assert.deepEqual(progress.child, { type: "start", step: { key: "start.starting_server", label: "Starting the server" } });
});

test("a child that names another parent, or a step no table knows, is not followed", async () => {
  assert.equal((await progressOfRecord(store(promote(), start({ parent_id: "someone-else" })), promote(), { now: NOW })).child, null);
  assert.equal((await progressOfRecord(store(promote(), start({ step: "start.unknown", child_id: "" })), promote(), { now: NOW })).child, null);
});

test("a success carries the workflow's result and no step; a failure its scrubbed error", async () => {
  const done = await progressOfRecord(store(), promote({ status: "succeeded", result: "promoted", ended_at: "2026-11-27T12:05:00.000Z" }), { now: NOW });
  assert.equal(done.result, "promoted");
  assert.equal(done.step, null);
  assert.equal(done.child, null);
  assert.equal(done.stoppedAt, "2026-11-27T12:05:00.000Z");
  assert.equal(done.elapsedSeconds, 300);
  const failed = await progressOfRecord(store(), promote({
    status: "failed", error: "Spawnpoint.RollbackFailed", cause: "see arn:aws:states:eu-central-1:123456789012:execution:x:y", ended_at: "2026-11-27T12:05:00.000Z",
  }), { now: NOW });
  assert.deepEqual(failed.failure, { error: "Spawnpoint.RollbackFailed", cause: "see [arn]" });
  assert.equal(failed.result, null);
  const aborted = await progressOfRecord(store(), promote({ status: "aborted", ended_at: "2026-11-27T12:05:00.000Z" }), { now: NOW });
  assert.equal(aborted.failure?.error, "ABORTED");
});

test("a caught failure is told with the step it went on to", async () => {
  const progress = await progressOfRecord(store(), promote({ caught_error: "Spawnpoint.V2StartFailedCompensated", caught_cause: "the host did not answer", caught_step: "promote.rolling_back", step: "promote.rolling_back", child_id: "" }), { now: NOW });
  assert.deepEqual(progress.caught, { error: "Spawnpoint.V2StartFailedCompensated", cause: "the host did not answer", step: { key: "promote.rolling_back", label: "Rolling back" } });
});

test("the host log reads the command the record names, only for a running or failed start or promotion", async () => {
  const asked: unknown[] = [];
  const hostLog = async (command: unknown) => { asked.push(command); return [{ at: "2026-11-27T12:01:00Z", kind: "step" as const, text: "World prepared" }]; };
  const named = { host_instance_id: INSTANCE, command_id: COMMAND, child_id: "" };
  assert.equal((await progressOfRecord(store(), promote(named), { now: NOW, hostLog })).hostLog?.length, 1);
  assert.deepEqual(asked, [{ instanceId: INSTANCE, commandId: COMMAND }]);
  assert.deepEqual((await progressOfRecord(store(), promote({ host_instance_id: INSTANCE, child_id: "" }), { now: NOW, hostLog })).hostLog, [], "no command yet");
  assert.equal((await progressOfRecord(store(), promote({ ...named, status: "succeeded" }), { now: NOW, hostLog })).hostLog, undefined);
  assert.equal((await progressOfRecord(store(), record("panel-stop-1", { type: "stop", ...named }), { now: NOW, hostLog })).hostLog, undefined);
  const broken = async () => { throw new Error("logs down"); };
  assert.equal((await progressOfRecord(store(), promote(named), { now: NOW, hostLog: broken })).hostLog, undefined, "a log that fails is left out");
});

test("the snapshot lists only running outer records, with their world and execution", () => {
  assert.deepEqual(observationOfRecord(promote()), {
    id: PROMOTE, type: "promote", status: "running", startedAt: "2026-11-27T12:00:00.000Z",
    providerRef: `arn:aws:states:eu-central-1:123456789012:execution:m:${PROMOTE}`, worldId: "prominence",
  });
  assert.equal(observationOfRecord(start()), null);
  assert.equal(observationOfRecord(promote({ status: "succeeded" })), null);
});

test("the running list takes the open outer records, and an execution only when it has no record at all", async () => {
  const execution = (id: string) => ({ id, type: "promote" as const, status: "running" as const, startedAt: "2026-11-27T11:00:00.000Z", providerRef: `arn:x:${id}`, worldId: "prominence" });
  const asked: string[] = [];
  const { recorded, unrecorded } = await runningOperations(
    [promote(), start(), host()],
    [execution(PROMOTE), execution(START), execution("panel-promote-old"), execution("panel-promote-just-ended")],
    async (id) => { asked.push(id); return id === "panel-promote-just-ended"; },
  );
  assert.deepEqual(recorded.map((operation) => operation.id), [PROMOTE]);
  assert.deepEqual(unrecorded.map((operation) => operation.id), ["panel-promote-old"]);
  assert.deepEqual(asked, ["panel-promote-old", "panel-promote-just-ended"], "an open record answers without a read");
});

// --- the reader: the record first, the execution only for a run without one ---------

const MACHINES = () => [{ type: "promote" as const, arn: "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-promote-release" }];

function sfnThatMustNotBeCalled(t: TestContext) {
  return { send: t.mock.fn(async () => { throw new Error("Step Functions must not be read for an operation with a record"); }) };
}

test("an operation with a record is read from the record alone", async (t) => {
  const sfn = sfnThatMustNotBeCalled(t);
  const read = createOperationProgressReader({
    sfn: sfn as never, records: store(promote(), start(), host()), machines: MACHINES,
    expectation: async () => ({ expectedSeconds: 300, expectedSamples: 5 }), now: () => NOW,
  });
  const progress = await read({ worldId: "prominence", operationId: PROMOTE });
  assert.equal(progress?.child?.step.key, "start.waiting_host");
  assert.equal(progress?.expectedSeconds, 300);
  assert.equal(await read({ worldId: "another", operationId: PROMOTE }), null, "another world's operation");
  assert.equal(await read({ worldId: "prominence", operationId: START }), null, "a nested run is followed through its outer one");
  assert.equal(sfn.send.mock.callCount(), 0);
});

test("an operation without a record is read from its execution, and the fallback is logged", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const id = "panel-promote-20261127T110000-bbbb2222";
  const sfn = { send: async (command: { constructor: { name: string } }) => command.constructor.name === "DescribeExecutionCommand"
    ? { status: "RUNNING", startDate: new Date("2026-11-27T11:00:00Z"), input: JSON.stringify({ worldId: "prominence" }) }
    : { events: [{ type: "TaskStateEntered", stateEnteredEventDetails: { name: "Commit Active" } }] } };
  const read = createOperationProgressReader({ sfn: sfn as never, records: store(), machines: MACHINES, expectation: async () => null, now: () => NOW });
  const progress = await read({ worldId: "prominence", operationId: id });
  assert.equal(progress?.step?.key, "promote.recording_release");
  assert.deepEqual(info.mock.calls.map((call) => call.arguments), [["operation_record_fallback", JSON.stringify({ reader: "progress", operationId: id, status: "running" })]]);
});

test("the command log reads the start document's streams of the named command, and nothing for a malformed name", async () => {
  const streams: string[] = [];
  const logs = { send: async (command: { input: { logStreamName: string } }) => { streams.push(command.input.logStreamName); return { events: [] }; } };
  const read = createCommandLogReader({ logs: logs as never });
  assert.deepEqual(await read({ instanceId: INSTANCE, commandId: COMMAND }), []);
  assert.deepEqual(streams.sort(), [`${COMMAND}/${INSTANCE}/startSession/stderr`, `${COMMAND}/${INSTANCE}/startSession/stdout`]);
  assert.deepEqual(await read({ instanceId: "i-../x", commandId: COMMAND }), []);
  assert.equal(streams.length, 2);
});
