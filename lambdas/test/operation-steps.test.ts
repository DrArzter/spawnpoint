import assert from "node:assert/strict";
import test from "node:test";

import { ENDED, mappedStates, STEP_LABELS, stepOfState, WORKFLOW_FILES, workflowOfMachine, type WorkflowName } from "../src/control-plane/operation-steps.ts";

// Every state of every workflow has a step or is listed as not shown:
// operation-workflows.test.ts holds the workflow files to it (ADR-0105).
const WORKFLOWS = Object.keys(WORKFLOW_FILES) as WorkflowName[];

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
