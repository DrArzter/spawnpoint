import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Parameters?: Record<string, unknown>;
  Catch?: Array<{ Next: string }>;
  Choices?: Array<Record<string, unknown>>;
};

type Definition = {
  StartAt: string;
  States: Record<string, State>;
};

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/promote-release.asl.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Definition;
}

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

function choiceTargets(choice: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (typeof choice.Next === "string") targets.push(choice.Next);
  for (const operator of ["And", "Or"]) {
    const nested = choice[operator];
    if (Array.isArray(nested)) {
      for (const item of nested) targets.push(...choiceTargets(item as Record<string, unknown>));
    }
  }
  if (choice.Not && typeof choice.Not === "object") {
    targets.push(...choiceTargets(choice.Not as Record<string, unknown>));
  }
  return targets;
}

test("promotion is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const names = new Set(Object.keys(definition.States));
  assert.ok(names.has(definition.StartAt));

  for (const [name, state] of Object.entries(definition.States)) {
    const targets: string[] = [];
    if (state.Next) targets.push(state.Next);
    if (state.Default) targets.push(state.Default);
    for (const choice of state.Choices ?? []) targets.push(...choiceTargets(choice));
    for (const caught of state.Catch ?? []) targets.push(caught.Next);
    for (const target of targets) {
      assert.ok(names.has(target), `${name} -> ${target} does not exist`);
    }
  }
});

test("desired is written before any host action, per ADR-0030", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Build Desired Document").Next, "Write Desired");
  assert.equal(state(definition, "Write Desired").Next, "Describe Instance");
  // The stop and start of the host are reachable only after the pointer write.
  assert.equal(state(definition, "Mark Origin Running").Next, "Stop Session");
  assert.equal(state(definition, "Mark Origin Stopped").Next, "Start With Target");
});

test("active commits only after the target start succeeded", async () => {
  const definition = await loadDefinition();
  const start = state(definition, "Start With Target");
  assert.equal(start.Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(start.Next, "Build Commit Document");
  assert.equal(start.Catch?.[0]?.Next, "Rollback Possible");
  assert.equal(state(definition, "Build Commit Document").Next, "Commit Active");

  const commit = state(definition, "Commit Active");
  const document = state(definition, "Build Commit Document").Parameters?.document as Record<string, unknown>;
  assert.equal(document["active_release.$"], "$.request.release");
  assert.match(String(commit.Parameters?.["Body.$"]), /JsonToString/);
});

test("rollback is the same mechanism in reverse: flip the pointer, start again", async () => {
  const definition = await loadDefinition();

  const gate = state(definition, "Rollback Possible");
  const noRollback = gate.Choices?.find((candidate) => candidate.IsNull === true);
  assert.equal(noRollback?.Next, "Promotion Failed No Rollback");
  assert.equal(gate.Default, "Build Rollback Document");

  const rollbackDoc = state(definition, "Build Rollback Document").Parameters?.document as Record<string, unknown>;
  assert.equal(rollbackDoc["desired_release.$"], "$.pointer.active_release");

  assert.equal(state(definition, "Write Rollback Desired").Next, "Start With Previous");
  assert.equal(state(definition, "Start With Previous").Catch?.[0]?.Next, "Rollback Failed");
});

test("a refused stop restores the pointer before failing", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Stop Session").Catch?.[0]?.Next, "Build Refusal Restore Document");

  const restored = state(definition, "Build Refusal Restore Document").Parameters?.document as Record<string, unknown>;
  assert.equal(restored["desired_release.$"], "$.pointer.desired_release");
  assert.equal(state(definition, "Restore Desired After Refusal").Next, "Promotion Refused");
  assert.equal(state(definition, "Promotion Refused").Type, "Fail");
});

test("the watchdog relaunch is fire-and-forget and never fails a finished promotion", async () => {
  const definition = await loadDefinition();
  for (const [name, terminal] of [
    ["Launch Watchdog", "Promoted Watchdogless"],
    ["Launch Watchdog After Rollback", "Rolled Back"],
  ] as const) {
    const launch = state(definition, name);
    assert.equal(launch.Resource, "arn:aws:states:::aws-sdk:sfn:startExecution");
    assert.equal(launch.Catch?.[0]?.Next, terminal);
    assert.notEqual(state(definition, terminal).Type, "Fail");
  }
});

test("a promotion that cannot re-stop the host fails loudly, not silently", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Stop After Commit").Catch?.[0]?.Next, "Promoted But Running");
  assert.equal(state(definition, "Stop After Rollback").Catch?.[0]?.Next, "Rolled Back But Running");
  for (const name of ["Promoted But Running", "Rolled Back But Running"]) {
    assert.equal(state(definition, name).Type, "Fail");
    assert.match(JSON.stringify(state(definition, name)), /running-hours alarm/);
  }
});

test("an already-active release is an idempotent success", async () => {
  const definition = await loadDefinition();
  const already = state(definition, "Already Active");
  const match = already.Choices?.find((candidate) => JSON.stringify(candidate).includes("active_release"));
  assert.equal(match?.Next, "Nothing To Do");
  assert.equal(state(definition, "Nothing To Do").End, true);
});

test("every pointer write goes through JsonToString, and every failure mode is distinct", async () => {
  const definition = await loadDefinition();
  const puts = Object.values(definition.States).filter(
    (state) => state.Resource === "arn:aws:states:::aws-sdk:s3:putObject",
  );
  assert.equal(puts.length, 4);
  for (const put of puts) {
    assert.match(String(put.Parameters?.["Body.$"]), /States\.JsonToString\(\$\.document\)/);
  }

  const fails = Object.entries(definition.States).filter(([, state]) => state.Type === "Fail");
  assert.equal(fails.length, 9);
  const errors = new Set(fails.map(([, state]) => (state as { Error?: string }).Error));
  assert.equal(errors.size, 9, "every failure mode must be distinguishable");
});
