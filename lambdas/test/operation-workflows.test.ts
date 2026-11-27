import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { instanceOfInput } from "../src/control-plane/operation-progress.ts";
import {
  GUARDED_WORKFLOW_FILES, HOST_START_MACHINE, mappedStates, NOT_SHOWN, stepOfState, type GuardedWorkflowName, type WorkflowName,
} from "../src/control-plane/operation-steps.ts";

// The guard of ADR-0105: every operation workflow is held to what the panel's
// readers take from it. A workflow change that the readers do not know fails here.

type State = Readonly<{ Type: string; Resource?: string; Parameters?: Readonly<Record<string, unknown>> }>;

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

function statesOf(workflow: GuardedWorkflowName): Readonly<Record<string, State>> {
  const text = readFileSync(new URL(`../../workflows/${GUARDED_WORKFLOW_FILES[workflow]}`, import.meta.url), "utf8")
    .replaceAll("${allowed_instance_types}", "[]")
    .replace(/\$\{([a-z0-9_]+)\}/g, (placeholder, name: string, offset: number, whole: string) => {
      const machine = MACHINE_PLACEHOLDERS[name];
      if (machine !== undefined) return `${ACCOUNT_SCOPE}:${machine}`;
      // A placeholder outside quotes is a number; inside, any string will do.
      return whole[offset - 1] === "\"" ? "x" : "0";
    });
  return (JSON.parse(text) as { States: Record<string, State> }).States;
}

const GUARDED = Object.keys(GUARDED_WORKFLOW_FILES) as GuardedWorkflowName[];
const SHOWN = new Set<GuardedWorkflowName>(["promote", "start", "stop", "start-host", "stop-host", "world"]);

for (const workflow of GUARDED) {
  test(`every state of the ${workflow} workflow has a step or is listed as not shown, and no list names a state it lacks`, () => {
    const states = Object.keys(statesOf(workflow));
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
