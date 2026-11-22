import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ENDED, mappedStates, STEP_LABELS, stepOfState, WORKFLOW_FILES, workflowOfMachine, type WorkflowName } from "../src/control-plane/operation-steps.ts";

// A template's placeholders become plain strings; only the state names matter.
function statesOf(workflow: WorkflowName): string[] {
  const text = readFileSync(new URL(`../../workflows/${WORKFLOW_FILES[workflow]}`, import.meta.url), "utf8")
    .replace("${allowed_instance_types}", "[]")
    .replace(/\$\{[^}]*\}/g, "x");
  return Object.keys((JSON.parse(text) as { States: Record<string, unknown> }).States);
}

const WORKFLOWS = Object.keys(WORKFLOW_FILES) as WorkflowName[];

for (const workflow of WORKFLOWS) {
  test(`every state of the ${workflow} workflow has a step, and no step names a state it lacks`, () => {
    const states = statesOf(workflow);
    assert.deepEqual(states.filter((state) => stepOfState(workflow, state) === null), [], "states without a step");
    assert.deepEqual(mappedStates(workflow).filter((state) => !states.includes(state)), [], "steps for states that are gone");
  });
}

test("every step key has plain words, and the labels name no key that is unused", () => {
  const used = new Set(WORKFLOWS.flatMap((workflow) => mappedStates(workflow).map((state) => stepOfState(workflow, state)!.key)));
  for (const key of used) assert.match(STEP_LABELS[key] ?? "", /^[A-Z][^_]+$/, key);
  assert.deepEqual(Object.keys(STEP_LABELS).filter((key) => !used.has(key)), []);
});

test("a step key is stable and names its workflow", () => {
  assert.equal(stepOfState("promote", "Keep Pre-Promotion Backup")?.key, "promote.keeping_backup");
  assert.equal(stepOfState("promote", "Start With Target")?.label, "Starting on the new release");
  assert.equal(stepOfState("start", "Launch Host")?.key, "start.launching_host");
  assert.equal(stepOfState("start-host", "Describe SSM Agent")?.key, "start.waiting_host");
  assert.equal(stepOfState("stop-host", "Get Stop Command")?.key, "stop.saving_world");
  assert.equal(stepOfState("promote", "Rolled Back")?.key, ENDED);
  assert.equal(stepOfState("promote", "No Such State"), null);
});

test("a machine is known by its name, whatever its account and region", () => {
  assert.equal(workflowOfMachine("arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-promote-release"), "promote");
  assert.equal(workflowOfMachine("arn:aws:states:eu-west-1:210987654321:stateMachine:spawnpoint-start-server"), "start-host");
  assert.equal(workflowOfMachine("arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-build-release"), null);
});
