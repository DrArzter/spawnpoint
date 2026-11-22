import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_MAX_PAGES, readOperationProgress, scrub,
  type ExecutionPort, type ExecutionSummary, type HistoryEvent, type HistoryPage,
} from "../src/control-plane/operation-progress.ts";
import { createOperationProgressReader, operationTypeOfId } from "../src/control-plane/aws-operation-progress.ts";

const ACCOUNT = "123456789012";
const machine = (name: string) => `arn:aws:states:eu-central-1:${ACCOUNT}:stateMachine:spawnpoint-${name}`;
const execution = (name: string, id: string) => `arn:aws:states:eu-central-1:${ACCOUNT}:execution:spawnpoint-${name}:${id}`;
const START = new Date("2026-11-22T10:00:00Z");
const NOW = new Date("2026-11-22T10:03:20Z");

const summary = (patch: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  status: "RUNNING", startDate: START, stopDate: null, input: JSON.stringify({ worldId: "prominence" }), output: undefined, error: undefined, cause: undefined, ...patch,
});

// Events are written oldest first, as a person reads a workflow, and served newest first.
const entered = (name: string): HistoryEvent => ({ entered: name });
const scheduled = (name: string, id: string, machineName: string): HistoryEvent =>
  ({ scheduledParameters: JSON.stringify({ StateMachineArn: machine(machineName), Name: id, Input: {} }) });
const failed = (error: string, cause: string, resourceType = "lambda"): HistoryEvent => ({ failure: { resourceType, error, cause } });

function fake(executions: Record<string, Readonly<{ summary: ExecutionSummary; events: readonly HistoryEvent[]; pageSize?: number }>>) {
  const reads: string[] = [];
  const port: ExecutionPort = {
    async describe(arn) { return executions[arn]?.summary ?? null; },
    async historyPage(arn, nextToken): Promise<HistoryPage> {
      reads.push(arn);
      const item = executions[arn];
      assert.ok(item, `unexpected read of ${arn}`);
      const newest = [...item.events].reverse();
      const size = item.pageSize ?? 100;
      const from = nextToken === undefined ? 0 : Number(nextToken);
      return { events: newest.slice(from, from + size), nextToken: from + size < newest.length ? String(from + size) : undefined };
    },
  };
  return { port, reads };
}

const request = (id: string, patch: Record<string, unknown> = {}) => ({
  id, type: "promote" as const, executionArn: execution("promote-release", id), workflow: "promote" as const, worldId: "prominence", now: NOW, ...patch,
});

test("a running promotion shows its current step, its elapsed time and its usual duration", async () => {
  const id = "panel-promote-20261122T100000-aaaa1111";
  const { port } = fake({ [execution("promote-release", id)]: { summary: summary(), events: [entered("Initialize"), entered("Verify Release Published"), entered("Prepare Release"), entered("Read Lifecycle"), entered("Keep Pre-Promotion Backup")] } });
  const progress = await readOperationProgress(port, request(id, { expectation: async () => ({ expectedSeconds: 540, expectedSamples: 8 }) }));
  assert.deepEqual(progress, {
    id, type: "promote", status: "running", startedAt: START.toISOString(), stoppedAt: null, elapsedSeconds: 200,
    expectedSeconds: 540, expectedSamples: 8,
    step: { key: "promote.keeping_backup", label: "Keeping the backup" }, child: null, result: null, failure: null, caught: null,
  });
});

test("a promotion that waits for a nested start shows the host's own step, two executions down", async () => {
  const id = "panel-promote-20261122T100000-bbbb2222";
  const v2 = `${id}-target-start`;
  const host = `${id}-host-start`;
  const { port } = fake({
    [execution("promote-release", id)]: { summary: summary(), events: [entered("Keep Pre-Promotion Backup"), entered("Start With Target"), scheduled("start-server-v2", v2, "start-server-v2")] },
    [execution("start-server-v2", v2)]: { summary: summary(), events: [entered("Initialize"), entered("Place Fleet Session"), entered("Start Accepted V1"), scheduled("start-server", host, "start-server")] },
    [execution("start-server", host)]: { summary: summary(), events: [entered("Initialize"), entered("Start Instance"), entered("Wait Before Instance Poll"), entered("Describe Instance")] },
  });
  const progress = await readOperationProgress(port, request(id));
  assert.deepEqual(progress?.step, { key: "promote.starting_release", label: "Starting on the new release" });
  assert.deepEqual(progress?.child, { type: "start", step: { key: "start.waiting_host", label: "Waiting for the host" } });
});

test("a nested start that has not reached the host shows its own step", async () => {
  const id = "panel-promote-20261122T100000-cccc3333";
  const v2 = `${id}-target-start`;
  const { port } = fake({
    [execution("promote-release", id)]: { summary: summary(), events: [entered("Start With Target"), scheduled("start-server-v2", v2, "start-server-v2")] },
    [execution("start-server-v2", v2)]: { summary: summary(), events: [entered("Initialize"), entered("Place Fleet Session"), entered("Route Placement"), entered("Launch Host")] },
  });
  assert.deepEqual((await readOperationProgress(port, request(id)))?.child, { type: "start", step: { key: "start.launching_host", label: "Launching the host" } });
});

test("a nested stop in a promotion is a stop child", async () => {
  const id = "panel-promote-20261122T100000-dddd4444";
  const stop = `${id}-origin-stop`;
  const { port } = fake({
    [execution("promote-release", id)]: { summary: summary(), events: [entered("Mark Origin Running"), entered("Stop Origin Session"), scheduled("stop-server-v2", stop, "stop-server-v2")] },
    [execution("stop-server-v2", stop)]: { summary: summary(), events: [entered("Initialize"), entered("Acquire Stop Lease")] },
  });
  const progress = await readOperationProgress(port, request(id));
  assert.equal(progress?.step?.key, "promote.stopping_server");
  assert.deepEqual(progress?.child, { type: "stop", step: { key: "stop.locking", label: "Locking the session" } });
});

test("a child that is gone or finished is left out, not an error", async () => {
  const id = "panel-promote-20261122T100000-eeee5555";
  const v2 = `${id}-target-start`;
  const events = [entered("Start With Target"), scheduled("start-server-v2", v2, "start-server-v2")];
  const gone = fake({ [execution("promote-release", id)]: { summary: summary(), events } });
  assert.equal((await readOperationProgress(gone.port, request(id)))?.child, null);
  const done = fake({
    [execution("promote-release", id)]: { summary: summary(), events },
    [execution("start-server-v2", v2)]: { summary: summary({ status: "SUCCEEDED" }), events: [entered("Ready")] },
  });
  assert.equal((await readOperationProgress(done.port, request(id)))?.child, null);
});

test("a child that names a machine outside the account, or an unknown one, is not followed", async () => {
  const id = "panel-promote-20261122T100000-ffff6666";
  const other = JSON.stringify({ StateMachineArn: "arn:aws:states:eu-central-1:999999999999:stateMachine:spawnpoint-start-server-v2", Name: "x" });
  const unknown = JSON.stringify({ StateMachineArn: machine("build-release"), Name: "x" });
  for (const scheduledParameters of [other, unknown, "not json", JSON.stringify({ StateMachineArn: machine("start-server-v2"), Name: "a/b" })]) {
    const { port, reads } = fake({ [execution("promote-release", id)]: { summary: summary(), events: [entered("Start With Target"), { scheduledParameters }] } });
    assert.equal((await readOperationProgress(port, request(id)))?.child, null);
    assert.equal(reads.length, 1, "only the promotion's own history is read");
  }
});

test("a failed promotion returns the workflow's own error and cause, and the task error it caught", async () => {
  const id = "panel-promote-20261122T100000-1111aaaa";
  const { port } = fake({ [execution("promote-release", id)]: {
    summary: summary({
      status: "FAILED", stopDate: new Date("2026-11-22T10:01:00Z"), error: "Spawnpoint.PrePromotionBackupMissing",
      cause: "This wipe ran a release but has no verified archive to keep before the promotion. The previous desired release was restored.",
    }),
    events: [
      entered("Keep Pre-Promotion Backup"),
      failed("Lambda.Unknown", JSON.stringify({ errorMessage: "backup arn:aws:s3:::spawnpoint-backups-123456789012/worlds/x is empty" })),
      entered("Restore Desired After Missing Backup"), entered("Pre-Promotion Backup Missing"),
    ],
  } });
  const progress = await readOperationProgress(port, request(id));
  assert.equal(progress?.status, "failed");
  assert.equal(progress?.stoppedAt, "2026-11-22T10:01:00.000Z");
  assert.equal(progress?.elapsedSeconds, 60);
  assert.equal(progress?.step, null);
  assert.deepEqual(progress?.failure, { error: "Spawnpoint.PrePromotionBackupMissing", cause: "This wipe ran a release but has no verified archive to keep before the promotion. The previous desired release was restored." });
  assert.deepEqual(progress?.caught, {
    error: "Lambda.Unknown",
    cause: `{"errorMessage":"backup [arn] is empty"}`,
    step: { key: "promote.keeping_backup", label: "Keeping the backup" },
  });
});

test("a task error that ended the workflow is the failure, not a caught error", async () => {
  const id = "panel-promote-20261122T100000-2222bbbb";
  const { port } = fake({ [execution("promote-release", id)]: {
    summary: summary({ status: "FAILED", stopDate: NOW, error: "Lambda.Unknown", cause: "boom" }),
    events: [entered("Prepare Release"), failed("Lambda.Unknown", "boom")],
  } });
  const progress = await readOperationProgress(port, request(id));
  assert.deepEqual(progress?.failure, { error: "Lambda.Unknown", cause: "boom" });
  assert.equal(progress?.caught, null);
});

test("a running rollback shows the failure that caused it", async () => {
  const id = "panel-promote-20261122T100000-3333cccc";
  const { port } = fake({ [execution("promote-release", id)]: { summary: summary(), events: [
    entered("Start With Target"),
    failed("Spawnpoint.V2StartFailedCompensated", "The start failed and was undone.", "states"),
    entered("Rollback Possible"), entered("Write Rollback Desired"),
  ] } });
  const progress = await readOperationProgress(port, request(id));
  assert.equal(progress?.step?.key, "promote.rolling_back");
  assert.deepEqual(progress?.caught, { error: "Spawnpoint.V2StartFailedCompensated", cause: "The start failed and was undone.", step: { key: "promote.starting_release", label: "Starting on the new release" } });
});

test("a nested execution's failure reaches the caller as the child's own error and cause", async () => {
  const id = "panel-promote-20261122T100000-4444dddd";
  const child = JSON.stringify({ Error: "Spawnpoint.SessionStartFailed", Cause: "The start command failed on the host." });
  const { port } = fake({ [execution("promote-release", id)]: { summary: summary(), events: [
    entered("Start With Target"), failed("States.TaskFailed", child, "states"), entered("Rollback Possible"),
  ] } });
  assert.deepEqual((await readOperationProgress(port, request(id)))?.caught, {
    error: "Spawnpoint.SessionStartFailed", cause: "The start command failed on the host.", step: { key: "promote.starting_release", label: "Starting on the new release" },
  });
});

test("a finished operation shows the workflow's verdict and no step", async () => {
  const id = "panel-promote-20261122T100000-5555eeee";
  const { port } = fake({ [execution("promote-release", id)]: {
    summary: summary({ status: "SUCCEEDED", stopDate: NOW, output: JSON.stringify({ status: "rolled_back", worldId: "prominence" }) }),
    events: [entered("Rolled Back")],
  } });
  const progress = await readOperationProgress(port, request(id, { expectation: async () => { throw new Error("a finished run needs no estimate"); } }));
  assert.equal(progress?.status, "succeeded");
  assert.equal(progress?.result, "rolled_back");
  assert.equal(progress?.step, null);
  assert.equal(progress?.expectedSeconds, undefined);
});

test("a timed out or aborted run is reported as such, with what the execution says", async () => {
  const id = "panel-start-20261122T100000-6666ffff";
  for (const [status, expected] of [["TIMED_OUT", "timed_out"], ["ABORTED", "aborted"]] as const) {
    const { port } = fake({ [execution("start-server-v2", id)]: { summary: summary({ status, stopDate: NOW }), events: [entered("Start Accepted V1")] } });
    const progress = await readOperationProgress(port, request(id, { type: "start", workflow: "start", executionArn: execution("start-server-v2", id) }));
    assert.equal(progress?.status, expected);
    assert.deepEqual(progress?.failure, { error: status, cause: "" });
  }
});

test("an execution that is not there, or that belongs to another world, is not found", async () => {
  const id = "panel-promote-20261122T100000-7777aaaa";
  const { port } = fake({ [execution("promote-release", id)]: { summary: summary({ input: JSON.stringify({ worldId: "other" }) }), events: [entered("Initialize")] } });
  assert.equal(await readOperationProgress(port, request(id)), null);
  assert.equal(await readOperationProgress(port, request("panel-promote-20261122T100000-missing0")), null);
});

test("the history is read newest first and in no more pages than the bound", async () => {
  const id = "panel-promote-20261122T100000-8888bbbb";
  const filler = Array.from({ length: 50 }, () => ({}) as HistoryEvent);
  const { port, reads } = fake({ [execution("promote-release", id)]: { pageSize: 10, summary: summary(), events: [...filler, entered("Initialize"), ...filler.slice(0, 3)] } });
  const progress = await readOperationProgress(port, request(id));
  assert.equal(progress?.step?.key, "promote.checking_release", "the newest state is on the first page");
  assert.equal(reads.length, HISTORY_MAX_PAGES, "no failure is found, so the read stops at the bound");
});

test("the current state alone needs one page when nothing was caught and none is wanted", async () => {
  const id = "panel-promote-20261122T100000-9999cccc";
  const { port, reads } = fake({
    [execution("promote-release", id)]: { summary: summary(), events: [entered("Start With Target"), scheduled("start-server-v2", `${id}-t`, "start-server-v2")] },
    [execution("start-server-v2", `${id}-t`)]: { pageSize: 2, summary: summary(), events: [entered("Initialize"), {}, {}, {}, {}, entered("Launch Host")] },
  });
  await readOperationProgress(port, request(id));
  assert.equal(reads.filter((arn) => arn.includes("start-server-v2")).length, 1);
});

test("a cause loses account numbers and ARNs and is cut at its limit", () => {
  assert.equal(scrub("role arn:aws:iam::123456789012:role/x denied in 123456789012", 200), "role [arn] denied in [account]");
  assert.equal(scrub("a".repeat(30), 10), `${"a".repeat(9)}…`);
});

test("an operation id names its workflow, and ids the panel never made name none", () => {
  assert.equal(operationTypeOfId("panel-promote-20261122T100000-aaaa1111"), "promote");
  assert.equal(operationTypeOfId("panel-start-20261122T100000-aaaa1111"), "start");
  assert.equal(operationTypeOfId("panel-stop-20261122T100000-aaaa1111"), "stop");
  assert.equal(operationTypeOfId("panel-world-regenerate-20261122T100000-aaaa1111"), "world");
  for (const id of ["panel-build-1", "panel-start-", "../panel-start-1", "panel-start-1/2", "session-1", "panel-world-1"]) assert.equal(operationTypeOfId(id), null, id);
});

test("the reader describes only the execution of the machine the id names", async () => {
  const id = "panel-stop-20261122T100000-aaaa1111";
  const seen: string[] = [];
  const sfn = { send: async (command: { constructor: { name: string }; input: { executionArn: string } }) => {
    seen.push(`${command.constructor.name} ${command.input.executionArn}`);
    return command.constructor.name === "DescribeExecutionCommand"
      ? { status: "RUNNING", startDate: START, input: JSON.stringify({ worldId: "prominence" }) }
      : { events: [{ type: "TaskStateEntered", stateEnteredEventDetails: { name: "Acquire Stop Lease" } }] };
  } };
  const read = createOperationProgressReader({
    sfn: sfn as never,
    machines: () => [{ type: "start", arn: machine("start-server-v2") }, { type: "stop", arn: machine("stop-server-v2") }],
    expectation: async () => ({ expectedSeconds: 90, expectedSamples: 4 }),
    now: () => NOW,
  });
  const progress = await read({ worldId: "prominence", operationId: id });
  assert.equal(progress?.step?.key, "stop.locking");
  assert.equal(progress?.expectedSeconds, 90);
  assert.deepEqual(seen, [`DescribeExecutionCommand ${execution("stop-server-v2", id)}`, `GetExecutionHistoryCommand ${execution("stop-server-v2", id)}`]);
  assert.equal(await read({ worldId: "prominence", operationId: "panel-build-1" }), null);
});
