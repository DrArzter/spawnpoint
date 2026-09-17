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
  const rendered = template
    .replaceAll("${allowed_instance_types}", JSON.stringify(["m7i-flex.*", "r7i.*"]))
    .replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource");
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
  assert.equal(state(definition, "Start Accepted V1").Next, "Route Bookkeeping");
  assert.equal(state(definition, "Route Bookkeeping").Default, "Describe Host");
  assert.equal(state(definition, "Reserve Slot Zero").Next, "Mark Session Ready");
  assert.equal(state(definition, "Mark Session Ready").Next, "Release Start Lease");
  assert.equal(state(definition, "Release Start Lease").Next, "Start Session Watchdog");
  assert.equal(state(definition, "Start Session Watchdog").Resource, "arn:aws:states:::aws-sdk:sfn:startExecution");
  assert.equal(state(definition, "Start Session Watchdog").Next, "Ready");
  assert.equal(state(definition, "Start Session Watchdog").Catch?.[0]?.Next, "Acquire Watchdog Compensation Lease");
  assert.equal(state(definition, "Acquire Watchdog Compensation Lease").Next, "Release Failed Placement");
  assert.equal(state(definition, "Release Failed Placement").Next, "Begin Compensating Stop");
});

test("a failed V1 start is durably stopped before lifecycle is cleared", async () => {
  const definition = await loadDefinition();

  assert.equal(state(definition, "Start Accepted V1").Catch?.[0]?.Next, "Release Failed Placement");
  assert.equal(state(definition, "Release Failed Placement").Catch?.[0]?.Next, "Begin Compensating Stop", "giving a slot back never blocks the compensation");
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
    "InstanceIds.$": "States.Array($.request.placed.hostId)",
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
  assert.equal(release.Next, "Route Emptied Host");
  assert.equal(release.Catch?.[0]?.Next, "Release Stop Lease");
  const payload = release.Parameters?.Payload as Record<string, unknown>;
  assert.equal(payload.action, "releasePlacement");
  assert.equal(payload["sessionId.$"], "$.request.sessionId");
  assert.equal("hostId.$" in payload, false, "the reservation is found by session, wherever the session was placed");
});

test("the placement mode routes the start: single adopts the configured host, shared asks the coordinator", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Begin Session").Next, "Route Placement Mode");
  const route = state(definition, "Route Placement Mode");
  assert.equal(route.Choices?.[0]?.Variable, "$.request.placement");
  assert.equal(route.Choices?.[0]?.Next, "Describe Configured Host");
  assert.equal(route.Default, "Adopt Configured Host");
  assert.deepEqual(state(definition, "Adopt Configured Host").Parameters, { "hostId.$": "$.request.instanceId", slot: "" });
  assert.equal(state(definition, "Adopt Configured Host").Next, "Start Accepted V1");

  // Shared: the configured host is always registered, so it is always a candidate.
  const chain = ["Describe Configured Host", "Describe Configured Host Shape", "Register Configured Host", "Place Session"];
  for (const [index, name] of chain.entries()) {
    const current = state(definition, name);
    assert.equal(current.Next, chain[index + 1] ?? "Route Placement");
    assert.equal(current.Catch?.[0]?.Next, "Placement Unavailable", `${name} refuses rather than starting unplaced`);
  }
  assert.equal((state(definition, "Place Session").Parameters?.Payload as Record<string, unknown>).action, "placeSession");
  assert.equal(state(definition, "Route Placement").Choices?.[0]?.Next, "Adopt Placement");
  assert.equal(state(definition, "Route Placement").Choices?.[1]?.Next, "Launch Host");
  assert.match(JSON.stringify(state(definition, "Route Placement").Choices?.[1]), /\$\.request\.launch/, "launching is a setting, off by default");
  assert.equal(state(definition, "Route Placement").Default, "No Host Has Room");
  assert.deepEqual(state(definition, "Adopt Placement").Parameters, { "hostId.$": "$.placement.placement.hostId", "slot.$": "$.placement.placement.slot" });
  assert.equal(state(definition, "Adopt Placement").Next, "Start Accepted V1");
  assert.equal(state(definition, "Route Bookkeeping").Choices?.[0]?.Next, "Mark Session Ready", "a placed session already holds its reservation");

  // Every host command from here on names the placed host and slot.
  const nested = state(definition, "Start Accepted V1").Parameters?.Input as Record<string, string>;
  assert.equal(nested["instanceId.$"], "$.request.placed.hostId");
  assert.equal(nested["slot.$"], "$.request.placed.slot");
  const watchdog = state(definition, "Start Session Watchdog").Parameters?.Input as Record<string, string>;
  assert.equal(watchdog["instanceId.$"], "$.request.placed.hostId");
  assert.equal(watchdog["slot.$"], "$.request.placed.slot");
  const compensate = state(definition, "Stop Accepted V1").Parameters?.Input as Record<string, string>;
  assert.equal(compensate["instanceId.$"], "$.request.placed.hostId");
  assert.equal(compensate["slot.$"], "$.request.placed.slot");
  assert.ok(!JSON.stringify(definition.States["Describe Forced Stop Host"]).includes("$.request.instanceId"));
});

test("a session nothing has room for is cancelled cleanly, not started", async () => {
  const definition = await loadDefinition();
  for (const name of ["No Host Has Room", "Placement Unavailable"]) {
    assert.equal(state(definition, name).Next, "Begin Cancelling Unplaced Session");
  }
  assert.equal((state(definition, "Begin Cancelling Unplaced Session").Parameters?.Payload as Record<string, unknown>).action, "beginStopping");
  assert.equal(state(definition, "Begin Cancelling Unplaced Session").Next, "Mark Unplaced Session Stopped");
  assert.equal((state(definition, "Mark Unplaced Session Stopped").Parameters?.Payload as Record<string, unknown>).action, "markStopped");
  assert.equal(state(definition, "Mark Unplaced Session Stopped").Next, "Release Unplaced Lease");
  assert.equal(state(definition, "Release Unplaced Lease").Next, "Start Refused Unplaced");
  assert.equal(state(definition, "Start Refused Unplaced").Type, "Fail");
  assert.ok(!JSON.stringify(definition.States["No Host Has Room"]).includes("startExecution"), "nothing is started on a host without room");
});

test("a launch asks EC2 for the footprint's requirements, records what came back, reserves it, and lets it go if it cannot", async () => {
  const definition = await loadDefinition();
  const launch = state(definition, "Launch Host") as Record<string, any>;
  assert.equal(launch.Resource, "arn:aws:states:::aws-sdk:ec2:createFleet");
  assert.equal(launch.Parameters.Type, "instant");
  const override = launch.Parameters.LaunchTemplateConfigs[0].Overrides[0].InstanceRequirements;
  assert.equal(override.MemoryMiB["Min.$"], "$.placement.placement.requirements.memoryMiB");
  assert.equal(override.VCpuCount["Min.$"], "$.placement.placement.requirements.vcpu");
  assert.equal(override.BurstablePerformance, "excluded");
  assert.ok(!("InstanceType" in launch.Parameters.LaunchTemplateConfigs[0].Overrides[0]), "no instance type is named; EC2 answers the requirements");
  assert.equal(launch.Parameters.OnDemandOptions.AllocationStrategy, "lowest-price");
  assert.ok(JSON.stringify(launch.Parameters.TagSpecifications).includes("$.request.appCommit"), "the host is told which commit to check out");
  assert.equal(launch.Catch?.[0]?.Next, "Placement Unavailable");
  assert.equal(launch.Next, "Describe Launched Host Shape");
  assert.equal(state(definition, "Describe Launched Host Shape").Next, "Register Launched Host");
  const register = state(definition, "Register Launched Host").Parameters?.Payload as Record<string, unknown>;
  assert.equal(register.provenance, "launched");
  assert.equal(register["hostId.$"], "$.launched.instanceId");
  assert.equal(state(definition, "Register Launched Host").Next, "Reserve On Launched Host");
  assert.equal(state(definition, "Reserve On Launched Host").Next, "Adopt Placement");
  for (const name of ["Describe Launched Host Shape", "Register Launched Host", "Reserve On Launched Host"]) {
    assert.equal(state(definition, name).Catch?.[0]?.Next, "Terminate Unreserved Host", `${name}: a host nobody recorded is let go at once`);
  }
  const terminate = state(definition, "Terminate Unreserved Host") as Record<string, any>;
  assert.equal(terminate.Resource, "arn:aws:states:::aws-sdk:ec2:terminateInstances");
  assert.equal(terminate.Parameters["InstanceIds.$"], "States.Array($.launched.instanceId)");
  assert.equal(terminate.Next, "Placement Unavailable");
});
