import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Parameters?: Record<string, any>;
  ResultSelector?: Record<string, string>;
  Choices?: Array<Record<string, unknown>>;
  Catch?: Array<{ Next: string }>;
};

type Definition = { StartAt: string; QueryLanguage: string; States: Record<string, State> };

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/drain-host-v2.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  const rendered = template
    .replaceAll("${grace_period_seconds}", "600")
    .replaceAll("${headroom_mib}", "0")
    .replaceAll("${max_keep_polls}", "288")
    .replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource");
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

test("the drain is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const reachable = new Set<string>();
  const queue = [definition.StartAt];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    const current = definition.States[name];
    assert.ok(current, `reachable state is missing: ${name}`);
    reachable.add(name);
    queue.push(...targets(current));
  }
  assert.deepEqual([...reachable].sort(), Object.keys(definition.States).sort());
});

test("the drain waits, asks, and moves the record before it touches the machine", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Initialize").Next, "Route Drain Urgency");
  assert.equal(state(definition, "Route Drain Urgency").Default, "Wait Out Grace Period");
  assert.equal(state(definition, "Wait Out Grace Period").Next, "Decide Drain");
  assert.equal(state(definition, "Decide Drain").Parameters?.Payload.action, "decideDrain");
  assert.equal(state(definition, "Decide Drain").ResultSelector?.["revision.$"], "$.Payload.host.revision");
  const route = state(definition, "Route Drain");
  assert.equal(route.Choices?.find((choice) => choice.StringEquals === "terminate")?.Next, "Conclude Termination");
  assert.equal(route.Choices?.find((choice) => choice.StringEquals === "stop")?.Next, "Conclude Stop");
  assert.equal(route.Default, "Count Kept Poll", "kept means ask again after another period, not give up");
  assert.equal(state(definition, "Kept Too Long").Default, "Wait Out Grace Period");
  assert.equal(state(definition, "Kept Too Long").Choices?.[0]?.Next, "Drain Gave Up");
  assert.equal(state(definition, "Drain Gave Up").Type, "Fail");

  // The record moves first, conditionally; a start that lands meanwhile wins.
  assert.equal(state(definition, "Conclude Termination").Parameters?.Payload.outcome, "terminate");
  assert.equal(state(definition, "Conclude Termination").Parameters?.Payload["expectedRevision.$"], "$.decision.revision");
  assert.equal(state(definition, "Conclude Termination").Next, "Terminate Host");
  assert.equal(state(definition, "Conclude Termination").Catch?.[0]?.Next, "Host Taken Back");
  assert.equal(state(definition, "Terminate Host").Resource, "arn:aws:states:::aws-sdk:ec2:terminateInstances");
  assert.equal(state(definition, "Terminate Host").Catch?.[0]?.Next, "Host Not Released");
  assert.equal(state(definition, "Conclude Stop").Next, "Stop Host");
  assert.equal(state(definition, "Conclude Stop").Parameters?.Payload["expectedRevision.$"], "$.decision.revision");
  assert.equal(state(definition, "Stop Host").Resource, "arn:aws:states:::aws-sdk:ec2:stopInstances");
  assert.equal(state(definition, "Host Not Released").Type, "Fail");
  assert.equal(state(definition, "Host Taken Back").End, true);
});

test("a failed start drains without grace or headroom, while still respecting a new reservation", async () => {
  const definition = await loadDefinition();
  const urgent = state(definition, "Route Drain Urgency");
  assert.deepEqual(urgent.Choices?.[0]?.And, [
    { Variable: "$.request.immediate", IsPresent: true },
    { Variable: "$.request.immediate", BooleanEquals: true },
  ], "normal stop omits immediate, so test presence before comparing it");
  assert.equal(urgent.Choices?.[0]?.Next, "Decide Immediate Drain");
  const decision = state(definition, "Decide Immediate Drain");
  assert.equal(decision.Parameters?.Payload.gracePeriodSeconds, 0);
  assert.equal(decision.Parameters?.Payload.headroomMiB, 0);
  assert.equal(decision.Next, "Route Drain");
  assert.equal(state(definition, "Route Drain").Choices?.find((choice) => choice.StringEquals === "ready")?.Next, "Host Taken Back");
});
