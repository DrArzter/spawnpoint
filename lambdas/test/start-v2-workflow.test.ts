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
  Choices?: Array<Record<string, unknown>>;
  Catch?: Array<{ Next: string }>;
};

type Definition = {
  StartAt: string;
  QueryLanguage: string;
  States: Record<string, State>;
};

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/start-server-v2.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  const rendered = template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource");
  return JSON.parse(rendered) as Definition;
}

function targets(state: State): string[] {
  return [
    state.Next,
    state.Default,
    ...(state.Choices ?? []).map((choice) => choice.Next as string | undefined),
    ...(state.Catch ?? []).map((handler) => handler.Next),
  ].filter((value): value is string => Boolean(value));
}

test("V2 start wrapper is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const reachable = new Set<string>();
  const queue = [definition.StartAt];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    const state = definition.States[name];
    assert.ok(state, `reachable state is missing: ${name}`);
    reachable.add(name);
    queue.push(...targets(state));
  }

  assert.deepEqual([...reachable].sort(), Object.keys(definition.States).sort());
});

test("V2 start owns lifecycle around the accepted V1 host operation", async () => {
  const definition = await loadDefinition();

  assert.equal(definition.QueryLanguage, "JSONPath");
  assert.equal(state(definition, "Acquire Start Lease").Resource, "arn:aws:states:::lambda:invoke");
  assert.equal(state(definition, "Start Accepted V1").Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(state(definition, "Start Accepted V1").Next, "Mark Session Ready");
  assert.equal(state(definition, "Mark Session Ready").Next, "Release Start Lease");
  assert.equal(state(definition, "Release Start Lease").Next, "Start Session Watchdog");
  assert.equal(state(definition, "Start Session Watchdog").Resource, "arn:aws:states:::aws-sdk:sfn:startExecution");
  assert.equal(state(definition, "Start Session Watchdog").Next, "Ready");
  assert.equal(state(definition, "Start Session Watchdog").Catch?.[0]?.Next, "Acquire Watchdog Compensation Lease");
  assert.equal(state(definition, "Acquire Watchdog Compensation Lease").Next, "Begin Compensating Stop");
});

test("a failed V1 start is durably stopped before lifecycle is cleared", async () => {
  const definition = await loadDefinition();

  assert.equal(state(definition, "Start Accepted V1").Catch?.[0]?.Next, "Begin Compensating Stop");
  assert.equal(state(definition, "Begin Compensating Stop").Next, "Stop Accepted V1");
  assert.equal(state(definition, "Stop Accepted V1").Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(
    (state(definition, "Stop Accepted V1").Parameters?.Input as Record<string, unknown>)["worldId.$"],
    "$.request.worldId",
  );
  assert.equal(state(definition, "Stop Accepted V1").Next, "Mark Compensated Session Stopped");
  assert.equal(state(definition, "Mark Compensated Session Stopped").Next, "Release Compensating Lease");
  assert.equal(state(definition, "Release Compensating Lease").Next, "Start Failed And Compensated");
  assert.equal(state(definition, "Start Failed And Compensated").Type, "Fail");
});
