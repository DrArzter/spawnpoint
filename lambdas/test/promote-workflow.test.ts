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
  assert.equal(state(definition, "Verify Release Published").Next, "Prepare Release");
  assert.equal(state(definition, "Prepare Release").Resource, "arn:aws:states:::lambda:invoke");
  assert.equal(state(definition, "Already Active").Default, "Read Lifecycle");
  assert.equal(state(definition, "Mark Origin Running").Next, "Stop Origin Session");
  assert.equal(state(definition, "Mark Origin Stopped").Next, "Start With Target");
});

test("active commits only after the target start succeeded", async () => {
  const definition = await loadDefinition();
  const start = state(definition, "Start With Target");
  assert.equal(start.Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(start.Next, "Commit Active");
  assert.equal(start.Catch?.[0]?.Next, "Rollback Possible");

  const commit = state(definition, "Commit Active");
  assert.equal(commit.Resource, "arn:aws:states:::lambda:invoke");
  const payload = commit.Parameters?.Payload as Record<string, unknown>;
  assert.equal(payload.action, "commit");
  assert.equal(payload["generationId.$"], "$.request.generationId");
});

test("rollback is the same mechanism in reverse with a distinct fenced session", async () => {
  const definition = await loadDefinition();

  const gate = state(definition, "Rollback Possible");
  const noRollback = gate.Choices?.find((candidate) => candidate.IsNull === true);
  assert.equal(noRollback?.Next, "Promotion Failed No Rollback");
  assert.equal(gate.Default, "Write Rollback Desired");

  assert.equal(state(definition, "Write Rollback Desired").Next, "Start With Previous");
  assert.equal((state(definition, "Write Rollback Desired").Parameters?.Payload as Record<string, unknown>).action, "rollback");
  assert.equal(state(definition, "Start With Previous").Catch?.[0]?.Next, "Rollback Failed");
  const rollbackInput = state(definition, "Start With Previous").Parameters?.Input as Record<string, unknown>;
  assert.equal(rollbackInput["sessionId.$"], "$.sessions.rollback");
});

test("a refused stop restores the pointer before failing", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Stop Origin Session").Catch?.[0]?.Next, "Restore Desired After Refusal");
  const restored = state(definition, "Restore Desired After Refusal").Parameters?.Payload as Record<string, unknown>;
  assert.equal(restored.action, "restore");
  assert.equal(restored["previous.$"], "$.mutation.previous");
  assert.equal(state(definition, "Restore Desired After Refusal").Next, "Promotion Refused");
  assert.equal(state(definition, "Promotion Refused").Type, "Fail");
});

test("promotion composes only Lifecycle V2 and lets V2 start own the watchdog", async () => {
  const definition = await loadDefinition();
  const serialized = JSON.stringify(definition);
  assert.equal(serialized.includes("watchdogStateMachineArn"), false);
  assert.equal(serialized.includes("spawnpoint-idle-watchdog"), false);

  for (const name of ["Start With Target", "Start With Previous"]) {
    const start = state(definition, name);
    assert.equal(start.Parameters?.StateMachineArn, "${start_v2_state_machine_arn}");
    const input = start.Parameters?.Input as Record<string, unknown>;
    assert.equal(input["watchdogTiming.$"], "$.request.watchdogTiming");
  }
  for (const name of ["Stop Origin Session", "Stop Target After Commit", "Stop Rollback Session"]) {
    assert.equal(state(definition, name).Parameters?.StateMachineArn, "${stop_v2_state_machine_arn}");
  }
});

test("a promotion that cannot re-stop the host fails loudly, not silently", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Stop Target After Commit").Catch?.[0]?.Next, "Promoted But Running");
  assert.equal(state(definition, "Stop Rollback Session").Catch?.[0]?.Next, "Rolled Back But Running");
  for (const name of ["Promoted But Running", "Rolled Back But Running"]) {
    assert.equal(state(definition, name).Type, "Fail");
    assert.match(JSON.stringify(state(definition, name)), /running-hours alarm/);
  }
});

test("an already-active release is an idempotent success", async () => {
  const definition = await loadDefinition();
  const already = state(definition, "Already Active");
  const match = already.Choices?.find((candidate) => JSON.stringify(candidate).includes("already_active"));
  assert.equal(match?.Next, "Nothing To Do");
  assert.equal(state(definition, "Nothing To Do").End, true);
});

test("the workflow delegates all release-state writes and knows no world storage path", async () => {
  const definition = await loadDefinition();
  const puts = Object.values(definition.States).filter(
    (state) => state.Resource === "arn:aws:states:::aws-sdk:s3:putObject",
  );
  assert.equal(puts.length, 0);
  assert.equal(JSON.stringify(definition).includes("worlds/"), false);
  const mutations = Object.values(definition.States).filter((candidate) =>
    candidate.Resource === "arn:aws:states:::lambda:invoke" &&
    candidate.Parameters?.FunctionName === "${release_state_function_arn}");
  assert.equal(mutations.length, 5);

  const fails = Object.entries(definition.States).filter(([, state]) => state.Type === "Fail");
  assert.equal(fails.length, 8);
  const errors = new Set(fails.map(([, state]) => (state as { Error?: string }).Error));
  assert.equal(errors.size, 8, "every failure mode must be distinguishable");
});

test("release identity is preset-scoped and child machine ARNs are not caller-controlled", async () => {
  const definition = await loadDefinition();
  const verify = state(definition, "Verify Release Published");
  assert.equal(
    verify.Parameters?.["Key.$"],
    "States.Format('releases/{}/{}/{}/manifest.json', $.request.gameId, $.request.presetId, $.request.release)",
  );

  const serialized = JSON.stringify(definition);
  assert.equal(serialized.includes("startStateMachineArn"), false);
  assert.equal(serialized.includes("stopStateMachineArn"), false);
  assert.equal(state(definition, "Read Lifecycle").Parameters?.FunctionName, "${coordinator_function_arn}");
});

test("target and rollback starts receive distinct generated session ids", async () => {
  const definition = await loadDefinition();
  const initialize = state(definition, "Initialize");
  const sessions = initialize.Parameters?.sessions as Record<string, unknown>;
  assert.equal(sessions["target.$"], "States.Format('session-{}', States.UUID())");
  assert.equal(sessions["rollback.$"], "States.Format('session-{}', States.UUID())");

  const target = state(definition, "Start With Target").Parameters?.Input as Record<string, unknown>;
  const rollback = state(definition, "Start With Previous").Parameters?.Input as Record<string, unknown>;
  assert.equal(target["sessionId.$"], "$.sessions.target");
  assert.equal(rollback["sessionId.$"], "$.sessions.rollback");
});

// The nested starts name the world — the V1 start builds its host command from
// it and would fail on a missing path — and carry no address, which the host
// reports back instead.
test("promotion's nested starts name the world and carry no address", async () => {
  const definition = await loadDefinition();
  for (const name of ["Start With Target", "Start With Previous"]) {
    const nested = (state(definition, name) as Record<string, any>).Parameters.Input as Record<string, string>;
    assert.equal(nested["worldId.$"], "$.request.worldId", `${name} must name the world`);
    assert.ok(!("connectionAddress.$" in nested), `${name} must not echo an address`);
  }
  assert.ok(!JSON.stringify(definition).includes("$.request.connectionAddress"));
});
