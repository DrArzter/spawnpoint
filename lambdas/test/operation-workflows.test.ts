import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { instanceOfInput } from "../src/control-plane/operation-progress.ts";
import { operationRecordKey } from "../src/control-plane/operation-record.ts";
import {
  ENDED, GUARDED_WORKFLOW_FILES, HOST_START_MACHINE, mappedStates, NOT_SHOWN, stepOfState, type GuardedWorkflowName, type WorkflowName,
} from "../src/control-plane/operation-steps.ts";
import { isOperationRecordState } from "./support/operation-record-states.ts";

// The guard of ADR-0105: every operation workflow is held to what the panel's
// readers take from it. A workflow change that the readers do not know fails here.

type State = Readonly<{
  Type: string;
  QueryLanguage?: string;
  Resource?: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Choices?: ReadonlyArray<Readonly<{ Next: string }>>;
  Catch?: ReadonlyArray<Readonly<{ ErrorEquals: readonly string[]; Next: string; Output?: string }>>;
  Retry?: ReadonlyArray<unknown>;
  Output?: string;
  Arguments?: unknown;
  Parameters?: Readonly<Record<string, unknown>>;
}>;

const RECORD_TABLE = "spawnpoint-control-plane-view";
const ACCOUNT_SCOPE = "arn:aws:states:eu-central-1:123456789012:stateMachine";

// The machine each template placeholder names, as the Terraform roots bind it
// (infra/terraform-operations/lifecycle-v2-workflows.tf, workflows.tf, drain-host-v2.tf;
// infra/terraform-access-api/world-lifecycle.tf).
const MACHINE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  start_v1_state_machine_arn: HOST_START_MACHINE,
  stop_v1_state_machine_arn: "spawnpoint-stop-server",
  start_v2_state_machine_arn: "spawnpoint-start-server-v2",
  stop_v2_state_machine_arn: "spawnpoint-stop-server-v2",
  stop_state_machine_arn: "spawnpoint-stop-server-v2",
  drain_state_machine_arn: "spawnpoint-lifecycle-v2-drain",
  watchdog_state_machine_arn: "spawnpoint-lifecycle-v2-watchdog",
};

function rendered(workflow: GuardedWorkflowName): string {
  return readFileSync(new URL(`../../workflows/${GUARDED_WORKFLOW_FILES[workflow]}`, import.meta.url), "utf8")
    .replaceAll("${allowed_instance_types}", "[]")
    .replace(/\$\{([a-z0-9_]+)\}/g, (placeholder, name: string, offset: number, whole: string) => {
      if (name === "operation_table_name") return RECORD_TABLE;
      const machine = MACHINE_PLACEHOLDERS[name];
      if (machine !== undefined) return `${ACCOUNT_SCOPE}:${machine}`;
      // A placeholder outside quotes is a number; inside, any string will do.
      return whole[offset - 1] === "\"" ? "x" : "0";
    });
}

function statesOf(workflow: GuardedWorkflowName): Readonly<Record<string, State>> {
  return (JSON.parse(rendered(workflow)) as { States: Record<string, State> }).States;
}

const GUARDED = Object.keys(GUARDED_WORKFLOW_FILES) as GuardedWorkflowName[];
const SHOWN = new Set<GuardedWorkflowName>(["promote", "start", "stop", "start-host", "stop-host", "world"]);

for (const workflow of GUARDED) {
  test(`every state of the ${workflow} workflow has a step or is listed as not shown, and no list names a state it lacks`, () => {
    // The record's own states are checked below, not mapped to a step.
    const states = Object.entries(statesOf(workflow)).filter(([, state]) => !isOperationRecordState(state)).map(([name]) => name);
    const notShown = new Set(NOT_SHOWN[workflow]);
    const stepped = SHOWN.has(workflow) ? mappedStates(workflow as WorkflowName) : [];
    const known = (state: string) => notShown.has(state) || (SHOWN.has(workflow) && stepOfState(workflow as WorkflowName, state) !== null);
    assert.deepEqual(states.filter((state) => !known(state)), [], "states with no step and not listed as not shown");
    assert.deepEqual([...stepped, ...notShown].filter((state) => !states.includes(state)), [], "names of states that are gone");
    assert.deepEqual(stepped.filter((state) => notShown.has(state)), [], "states both shown and not shown");
  });
}

/** The states that start a run of this machine, with the input they give it. */
function startsOf(states: Readonly<Record<string, State>>, machine: string): Array<Readonly<{ name: string; input: unknown }>> {
  return Object.entries(states).flatMap(([name, state]) => {
    const starts = state.Type === "Task" && /^arn:aws:states:::(states:startExecution|aws-sdk:sfn:startExecution)/.test(state.Resource ?? "");
    return starts && state.Parameters?.StateMachineArn === `${ACCOUNT_SCOPE}:${machine}` ? [{ name, input: state.Parameters.Input }] : [];
  });
}

// Each value the workflow computes becomes a distinct instance id, so the id the
// reader returns names the path it came from.
function withPathTokens(value: unknown, paths: string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    if (!key.endsWith(".$")) return [key, withPathTokens(inner, paths)];
    paths.push(String(inner));
    return [key.slice(0, -2), `i-${String(paths.length).padStart(17, "0")}`];
  }));
}

test("some workflow starts the host workflow, so the host guard below has something to hold", () => {
  assert.ok(GUARDED.some((workflow) => startsOf(statesOf(workflow), HOST_START_MACHINE).length > 0));
});

for (const workflow of GUARDED) {
  for (const start of startsOf(statesOf(workflow), HOST_START_MACHINE)) {
    test(`${workflow} "${start.name}" passes the host's instance where the host log reads it`, () => {
      const paths: string[] = [];
      const input = withPathTokens(start.input, paths);
      const instanceId = instanceOfInput(JSON.stringify(input));
      assert.notEqual(instanceId, null, "the host log reader finds no instance in this input");
      const path = paths[Number(instanceId!.slice(2)) - 1] ?? "";
      assert.match(path, /\.(hostId|instanceId)$/, `the reader takes the instance from ${path}, which is not a host`);
    });
  }
}

// ---- the record writes (ADR-0105) ------------------------------------------------

const RECORDED: readonly GuardedWorkflowName[] = ["promote", "start", "stop", "start-host", "stop-host", "world", "delete-host"];
const RUN_KEY = operationRecordKey("{id}");

/** The literal values a record write sets, by attribute name; a computed value reads as `*`. */
function written(state: State): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  const args = state.Arguments;
  if (typeof args === "string") {
    // The accepted write is one expression; its literal fields read `'name': {'S': 'value'}`.
    for (const match of args.matchAll(/'([a-z_]+)': \{'[SN]': ([^}]+)\}/g)) {
      const literal = /^'([^']*)'$/.exec(match[2]!.trim());
      fields.set(match[1]!, literal ? literal[1]! : "*");
    }
    return fields;
  }
  const request = args as { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, { S?: string; N?: string }> };
  for (const [alias, name] of Object.entries(request.ExpressionAttributeNames)) {
    const value = request.ExpressionAttributeValues[`:${alias.slice(1)}`];
    const raw = value?.S ?? value?.N;
    if (raw !== undefined) fields.set(name, raw.startsWith("{%") ? "*" : raw);
    else if (new RegExp(`REMOVE .*${alias}\\b`).test(request.UpdateExpression)) fields.set(name, "<removed>");
  }
  return fields;
}

function writes(states: Readonly<Record<string, State>>): Array<[string, State]> {
  return Object.entries(states).filter(([, state]) => isOperationRecordState(state) && state.Type === "Task");
}

/** Every record write the run passes from this edge until it reaches a workflow state, and that state. */
function follow(states: Readonly<Record<string, State>>, target: string): Readonly<{ through: State[]; reaches: string | null }> {
  const through: State[] = [];
  let at: string | undefined = target;
  const seen = new Set<string>();
  while (at !== undefined && states[at] !== undefined && isOperationRecordState(states[at]!)) {
    assert.ok(!seen.has(at), `record states loop at ${at}`);
    seen.add(at);
    const state: State = states[at]!;
    if (state.Type === "Task") through.push(state);
    if (state.End === true || state.Type === "Succeed") return { through, reaches: null };
    at = state.Type === "Choice" ? state.Default : state.Next;
  }
  return { through, reaches: at ?? null };
}

function edgesOf(state: State): Array<Readonly<{ target: string; caught: boolean }>> {
  return [
    ...[state.Next, state.Default, ...(state.Choices ?? []).map((choice) => choice.Next)].filter((target): target is string => target !== undefined)
      .map((target) => ({ target, caught: false })),
    ...(state.Catch ?? []).map((catcher) => ({ target: catcher.Next, caught: true })),
  ];
}

for (const workflow of RECORDED) {
  const states = statesOf(workflow);
  const stepOf = (name: string): string | null => SHOWN.has(workflow) ? stepOfState(workflow as WorkflowName, name)?.key ?? null : null;
  const shownStep = (name: string): string | null => { const key = stepOf(name); return key === ENDED ? null : key; };

  test(`${workflow}: every record write is an update of the run's own key, or of its parent's or root's, and never fails the run`, () => {
    for (const [name, state] of writes(states)) {
      assert.equal(state.Resource, "arn:aws:states:::dynamodb:updateItem", name);
      assert.equal(state.Output, "{% $states.input %}", `${name} passes its input on`);
      assert.ok(state.Retry !== undefined, `${name} retries`);
      const catcher = state.Catch?.[0];
      assert.deepEqual(catcher?.ErrorEquals, ["States.ALL"], `${name} catches every error`);
      assert.equal(catcher?.Output, "{% $states.input %}", `${name} passes its input on when the write fails`);
      if (state.End !== true) assert.equal(catcher?.Next, state.Next, `${name} goes on to the same state when the write fails`);
      const args = state.Arguments;
      const keyText = typeof args === "string" ? args : JSON.stringify((args as { Key: unknown }).Key);
      assert.ok(keyText.includes(`'${RUN_KEY.pk.replace("{id}", "")}' &`), `${name} writes a key of operationRecordKey's shape`);
      assert.ok(keyText.includes(RUN_KEY.sk), `${name} writes the record's sort key`);
      const table = typeof args === "string" ? /'TableName': '([^']*)'/.exec(args)?.[1] : (args as { TableName: string }).TableName;
      assert.equal(table, RECORD_TABLE, `${name} writes the record table`);
    }
  });

  test(`${workflow}: the run is accepted first, as running, with its type and expiry`, () => {
    const definition = JSON.parse(rendered(workflow)) as { StartAt: string };
    const first = states[definition.StartAt]!;
    assert.ok(isOperationRecordState(first) && first.Type === "Task", "the first state writes the record");
    const fields = written(first);
    assert.equal(fields.get("status"), "running");
    for (const name of ["operation_id", "type", "root_id", "started_at", "open_key", "expires_at"]) assert.ok(fields.has(name), `accepted sets ${name}`);
    const { reaches } = follow(states, definition.StartAt);
    if (reaches !== null && shownStep(reaches) !== null) assert.equal(fields.get("step"), shownStep(reaches), "accepted names the first step");
  });

  test(`${workflow}: every path to an end passes a write that sets the final status`, () => {
    for (const [name, state] of Object.entries(states)) {
      if (isOperationRecordState(state)) {
        if (state.Type === "Task" && state.End === true) assert.equal(written(state).get("status"), "succeeded", name);
        continue;
      }
      assert.notEqual(state.End, true, `${name} ends the run without a final write`);
      if (state.Type !== "Fail" && state.Type !== "Succeed") continue;
      const into = Object.entries(states).flatMap(([from, source]) => edgesOf(source).filter((edge) => edge.target === name).map(() => from));
      assert.ok(into.length > 0, `${name} is reached`);
      for (const from of into) {
        const fields = written(states[from]!);
        assert.equal(fields.get("status"), state.Type === "Fail" ? "failed" : "succeeded", `${from} → ${name} sets the final status`);
        assert.equal(fields.get("open_key"), "<removed>", `${from} → ${name} closes the record`);
      }
    }
  });

  if (SHOWN.has(workflow)) {
    test(`${workflow}: every edge into a shown step passes a write of that step`, () => {
      for (const [from, state] of Object.entries(states)) {
        if (isOperationRecordState(state)) continue;
        for (const edge of edgesOf(state)) {
          const { through, reaches } = follow(states, edge.target);
          if (reaches === null) continue;
          const step = shownStep(reaches);
          if (step === null || step === stepOf(from)) continue;
          assert.ok(through.some((write) => written(write).get("step") === step), `${from} → ${reaches} names ${step}`);
        }
      }
    });
  }
}

/** Every nested run of a recorded workflow learns its parent and its root. */
for (const workflow of RECORDED) {
  const nested = ["spawnpoint-start-server-v2", "spawnpoint-stop-server-v2", HOST_START_MACHINE, "spawnpoint-stop-server"];
  for (const machine of nested) {
    for (const start of startsOf(statesOf(workflow), machine)) {
      test(`${workflow} "${start.name}" tells its nested run its parent and root`, () => {
        const input = start.input as Record<string, unknown>;
        assert.equal(input["operationParent.$"], "$$.Execution.Name");
        assert.equal(input["operationRoot.$"], "$operationRoot");
      });
    }
  }
}

test("the host start writes its host and its command to its own record and to the root's", () => {
  const states = statesOf("start-host");
  const fields = writes(states).map(([, state]) => written(state));
  assert.ok(fields.some((set) => set.get("host_instance_id") === "*" && set.get("command_id") === "<removed>"), "the root learns the host");
  assert.ok(writes(states).some(([, state]) => typeof state.Arguments === "string" && state.Arguments.includes("'host_instance_id': {'S': $states.context.Execution.Input.instanceId}")), "accepted names the host");
  const senders = Object.entries(states).filter(([, state]) => (state.Resource ?? "").endsWith("ssm:sendCommand"));
  assert.ok(senders.length > 0);
  for (const [name, state] of senders) {
    const { through } = follow(states, state.Next!);
    assert.equal(through.filter((write) => written(write).get("command_id") === "*").length, 2, `${name}: the command reaches the run's record and the root's`);
  }
});
