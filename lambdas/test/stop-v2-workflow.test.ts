import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Choices?: Array<Record<string, unknown>>;
  Catch?: Array<{ Next: string }>;
};

type Definition = {
  StartAt: string;
  QueryLanguage: string;
  States: Record<string, State>;
};

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/stop-server-v2.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  const rendered = template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource");
  return JSON.parse(rendered) as Definition;
}

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

function targets(state: State): string[] {
  return [
    state.Next,
    state.Default,
    ...(state.Choices ?? []).map((choice) => choice.Next as string | undefined),
    ...(state.Catch ?? []).map((handler) => handler.Next),
  ].filter((value): value is string => Boolean(value));
}

test("V2 stop wrapper is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const reachable = new Set<string>();
  const queue = [definition.StartAt];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    const current = state(definition, name);
    reachable.add(name);
    queue.push(...targets(current));
  }

  assert.deepEqual([...reachable].sort(), Object.keys(definition.States).sort());
});

test("V2 stop holds one fenced lease across the accepted verified stop", async () => {
  const definition = await loadDefinition();

  assert.equal(definition.QueryLanguage, "JSONPath");
  assert.equal(state(definition, "Read Lifecycle").Next, "Route Lifecycle");
  assert.equal(state(definition, "Route Lifecycle").Default, "Stale Session");
  assert.equal(state(definition, "Acquire Stop Lease").Next, "Begin Stopping Session");
  assert.equal(state(definition, "Begin Stopping Session").Next, "Stop Accepted V1");
  assert.equal(state(definition, "Stop Accepted V1").Resource, "arn:aws:states:::states:startExecution.sync:2");
  assert.equal(state(definition, "Stop Accepted V1").Next, "Mark Session Stopped");
  assert.equal(state(definition, "Mark Session Stopped").Next, "Release Stop Lease");
  assert.equal(state(definition, "Release Stop Lease").Next, "Stopped");
});

test("an already stopped server exits before acquiring a lease", async () => {
  const definition = await loadDefinition();
  const route = state(definition, "Route Lifecycle");

  assert.match(JSON.stringify(route), /Already Stopped/);
  assert.equal(state(definition, "Already Stopped").Type, "Pass");
  assert.equal(state(definition, "Already Stopped").End, true);
  assert.equal(state(definition, "Stale Session").Type, "Fail");
});

test("failed host stop never claims lifecycle is stopped", async () => {
  const definition = await loadDefinition();
  const failed = state(definition, "Verified Stop Failed");

  assert.equal(state(definition, "Stop Accepted V1").Catch?.[0]?.Next, "Route Stop Failure");
  assert.equal(failed.Type, "Fail");
  assert.match(JSON.stringify(failed), /remains stopping/);
  assert.notEqual(failed.Next, "Mark Session Stopped");
});

test("a player race restores the same session to ready before releasing the lease", async () => {
  const definition = await loadDefinition();

  assert.equal(state(definition, "Route Stop Failure").Default, "Verified Stop Failed");
  assert.equal(state(definition, "Cancel Refused Stop").Next, "Release Refused Stop Lease");
  assert.equal(state(definition, "Release Refused Stop Lease").Next, "Stop Refused Players Online");
  assert.equal(state(definition, "Stop Refused Players Online").Type, "Fail");
});
