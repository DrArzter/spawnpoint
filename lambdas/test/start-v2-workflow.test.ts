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
  assert.equal(state(definition, "Start Accepted V1").Next, "Describe Host");
  assert.equal(state(definition, "Reserve Slot Zero").Next, "Mark Session Ready");
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

test("a failed verified compensation force-stops the billed host with a bounded poll", async () => {
  const definition = await loadDefinition();

  assert.equal(state(definition, "Stop Accepted V1").Catch?.[0]?.Next, "Force Stop Failed Start Host");
  assert.equal(state(definition, "Force Stop Failed Start Host").Resource, "arn:aws:states:::aws-sdk:ec2:stopInstances");
  assert.deepEqual(state(definition, "Force Stop Failed Start Host").Parameters, {
    "InstanceIds.$": "States.Array($.request.instanceId)",
  });
  assert.equal(state(definition, "Describe Forced Stop Host").Resource, "arn:aws:states:::aws-sdk:ec2:describeInstances");
  assert.equal(state(definition, "Forced Stop Host Stopped").Default, "Increment Forced Stop Poll");
  assert.equal(state(definition, "Increment Forced Stop Poll").Next, "Forced Stop Poll Limit Reached");
  assert.equal(state(definition, "Forced Stop Poll Limit Reached").Default, "Wait Before Forced Stop Poll");
  assert.equal(state(definition, "Mark Forced Session Stopped").Next, "Release Forced Compensation Lease");
  assert.equal(state(definition, "Release Forced Compensation Lease").Next, "Start Failed Host Forced Stopped");
  assert.equal(state(definition, "Start Failed Host Forced Stopped").Type, "Fail");
});

test("the lifecycle records which world owns the active shared-host session", async () => {
  const definition = await loadDefinition();
  const payload = state(definition, "Begin Session").Parameters?.Payload as Record<string, unknown>;
  assert.equal(payload["worldId.$"], "$.request.worldId");
});

test("V2 passes the host's address through instead of echoing the request's", async () => {
  const definition = await loadDefinition();
  const parameters = (name: string): Record<string, any> => (state(definition, name) as Record<string, any>).Parameters;
  const nested = parameters("Start Accepted V1").Input as Record<string, string>;
  assert.ok(!("connectionAddress.$" in nested), "the nested V1 request carries no address");
  assert.equal(nested["worldId.$"], "$.request.worldId");
  const ready = parameters("Ready");
  assert.equal(ready["connectionAddress.$"], "$.hostStart.Output.connectionAddress");
  assert.equal(ready["connectivity.$"], "$.hostStart.Output.connectivity");
  assert.ok(!JSON.stringify(definition).includes("$.request.connectionAddress"));
});

test("placement bookkeeping records the host and slot zero, and never fails a start that succeeded", async () => {
  const definition = await loadDefinition();
  const chain = ["Describe Host", "Describe Host Shape", "Register Host", "Reserve Slot Zero"];
  for (const [index, name] of chain.entries()) {
    const current = state(definition, name);
    assert.equal(current.Next, chain[index + 1] ?? "Mark Session Ready");
    // Read by nobody yet (ADR-0054, phase 5): a failure lands the start where it was going anyway.
    assert.equal(current.Catch?.[0]?.Next, "Mark Session Ready", `${name} fails open`);
  }
  assert.equal(state(definition, "Describe Host").Resource, "arn:aws:states:::aws-sdk:ec2:describeInstances");
  assert.equal(state(definition, "Describe Host Shape").Resource, "arn:aws:states:::aws-sdk:ec2:describeInstanceTypes");
  const register = state(definition, "Register Host").Parameters?.Payload as Record<string, unknown>;
  assert.equal(register.action, "registerHost");
  assert.equal(register["hostId.$"], "$.request.instanceId");
  assert.equal((register.shape as Record<string, unknown>)["memoryMiB.$"], "$.host.shape.memoryMiB");
  const reserve = state(definition, "Reserve Slot Zero").Parameters?.Payload as Record<string, unknown>;
  assert.equal(reserve.action, "reserveOnHost");
  assert.equal(reserve["sessionId.$"], "$.request.sessionId");
  assert.equal(reserve["worldId.$"], "$.request.worldId");
  assert.equal(reserve["serverId.$"], "$.request.serverId");
});

test("the stop releases the session's reservation after the verified stop, and tolerates one that never existed", async () => {
  const url = new URL("../../workflows/stop-server-v2.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  const definition = JSON.parse(template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource")) as Definition;
  assert.equal(state(definition, "Mark Session Stopped").Next, "Release Placement");
  const release = state(definition, "Release Placement");
  assert.equal(release.Next, "Release Stop Lease");
  assert.equal(release.Catch?.[0]?.Next, "Release Stop Lease");
  const payload = release.Parameters?.Payload as Record<string, unknown>;
  assert.equal(payload.action, "releasePlacement");
  assert.equal(payload["hostId.$"], "$.request.instanceId");
  assert.equal(payload["sessionId.$"], "$.request.sessionId");
});
