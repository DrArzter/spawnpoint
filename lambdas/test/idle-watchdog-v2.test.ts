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
  Catch?: Array<{ ErrorEquals?: string[]; ResultPath?: string; Next: string }>;
};

type Definition = { StartAt: string; States: Record<string, State> };

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/idle-watchdog-v2.asl.json.tftpl", import.meta.url);
  const template = await readFile(url, "utf8");
  return JSON.parse(
    template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource"),
  ) as Definition;
}

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

function choiceTargets(choice: Record<string, unknown>): string[] {
  const result = typeof choice.Next === "string" ? [choice.Next] : [];
  for (const operator of ["And", "Or"]) {
    const nested = choice[operator];
    if (Array.isArray(nested)) {
      for (const item of nested) result.push(...choiceTargets(item as Record<string, unknown>));
    }
  }
  return result;
}

test("V2 watchdog is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const reachable = new Set<string>();
  const queue = [definition.StartAt];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    const current = state(definition, name);
    reachable.add(name);
    if (current.Next) queue.push(current.Next);
    if (current.Default) queue.push(current.Default);
    for (const choice of current.Choices ?? []) queue.push(...choiceTargets(choice));
    for (const caught of current.Catch ?? []) queue.push(caught.Next);
  }

  assert.deepEqual([...reachable].sort(), Object.keys(definition.States).sort());
});

test("watchdog identity is the Step Functions execution and every observation is persisted", async () => {
  const definition = await loadDefinition();
  const serialized = JSON.stringify(definition);

  assert.match(serialized, /registerWatchdog/);
  assert.match(serialized, /\$\$\.Execution\.Id/);
  assert.match(serialized, /recordPlayerObservation/);
  assert.match(serialized, /isIdleStopEligible/);
  assert.match(serialized, /check-session-activity\.sh/);
  assert.match(serialized, /playersOnline/);
  // The probe is asked for a document and read by name. Splitting its output
  // into lines made the machine depend on the order the script prints them in,
  // which nothing in the repository would have failed on.
  assert.match(serialized, /PROBE_FORMAT=json/);
  assert.match(serialized, /States\.StringToJson\(\$\.observed\.invocation\.StandardOutputContent\)/);
  assert.equal(state(definition, "Parse Probe Output").Next, "Extract Player Count");
  const observed = state(definition, "Extract Player Count").Parameters?.observed as Record<string, unknown> | undefined;
  assert.equal(observed?.["playersOnline.$"], "$.observed.probe.playersOnline");
  assert.doesNotMatch(serialized, /StringSplit/);
  assert.equal(state(definition, "Register This Watchdog").Catch?.[0]?.Next, "Release Rejected Registration Lease");
  assert.equal(state(definition, "Release Rejected Registration Lease").Next, "Watchdog Registration Rejected");
});

test("unknown probes cannot enter the idle-stop eligibility path", async () => {
  const definition = await loadDefinition();

  assert.equal(state(definition, "Record Command Unknown").Next, "Count Probe Failure");
  assert.equal(state(definition, "Record Synthetic Unknown").Next, "Count Probe Failure");
  assert.equal(state(definition, "Count Probe Failure").Next, "Probe Failure Limit Reached");
  assert.notEqual(state(definition, "Probe Failure Limit Reached").Default, "Check Idle Eligibility");
  assert.equal(state(definition, "Record Successful Observation").Next, "Has Memory Reading");
  assert.equal(state(definition, "Count Successful Probe").Next, "Check Idle Eligibility");
});

test("a probe step that errors counts as a failed probe instead of failing the watchdog", async () => {
  const definition = await loadDefinition();
  const failure = (name: string) => {
    const caught = state(definition, name).Catch ?? [];
    const last = caught.at(-1);
    assert.deepEqual(last?.ErrorEquals, ["States.ALL"], `${name} catches every error last`);
    assert.equal(last?.ResultPath, "$.observed.probeError", `${name} keeps the request and counters`);
    return last?.Next;
  };

  // The command was sent: its id is the observation, as for an unknown status.
  assert.equal(failure("Get Probe Result"), "Record Command Unknown");
  assert.equal(state(definition, "Get Probe Result").Catch?.[0]?.Next, "Increment Probe Poll", "a result not yet there is polled again");
  // No command was sent: a synthetic observation, as for a failed send.
  assert.equal(failure("Describe Host"), "Record Synthetic Unknown");
  for (const name of ["Send Placed Probe", "Send Structured Probe"]) assert.equal(failure(name), "Record Synthetic Unknown");
  assert.equal(state(definition, "Record Command Unknown").Next, "Count Probe Failure");
  assert.equal(state(definition, "Record Synthetic Unknown").Next, "Count Probe Failure");
});

test("idle and capped stops target only the V2 session-scoped stop machine", async () => {
  const definition = await loadDefinition();
  for (const name of ["Stop Idle Session", "Stop Capped Session", "Reconcile Externally Stopped Host"]) {
    const stop = state(definition, name);
    assert.equal(stop.Resource, "arn:aws:states:::states:startExecution.sync:2");
    assert.match(JSON.stringify(stop.Parameters), /sessionId/);
  }
  assert.equal(state(definition, "Route Idle Stop Failure").Default, "Watchdog Stop Failing");
  assert.equal(state(definition, "Count Stop Refusal").Next, "Stop Refusal Limit Reached");
});

test("a stale watchdog exits successfully after a newer session owns lifecycle", async () => {
  const definition = await loadDefinition();
  for (const name of ["Route Idle Stop Failure", "Route Capped Stop Failure", "Route Reconcile Failure"]) {
    const route = state(definition, name);
    const stale = route.Choices?.find((choice) => JSON.stringify(choice).includes("V2StaleSession"));
    assert.equal(stale?.Next, "Session Superseded");
    assert.equal(route.Default, "Watchdog Stop Failing");
  }
  assert.equal(state(definition, "Stop Capped Session").Catch?.[0]?.Next, "Route Capped Stop Failure");
  assert.equal(state(definition, "Reconcile Externally Stopped Host").Catch?.[0]?.Next, "Route Reconcile Failure");
  assert.equal(state(definition, "Session Superseded").End, true);
});

test("a cap reached with players online hands the session to a fresh watchdog", async () => {
  const definition = await loadDefinition();
  const refused = state(definition, "Route Capped Stop Failure").Choices
    ?.find((choice) => JSON.stringify(choice).includes("V2StopRefusedPlayersOnline"));
  assert.equal(refused?.Next, "Route Hand Over", "a refused capped stop must not be treated as a failure");

  // The relay is the watchdog itself, named apart from the execution that
  // started it, and it carries the slot only when there is one to carry.
  const placed = state(definition, "Hand Over Placed Session");
  const unplaced = state(definition, "Hand Over Session");
  assert.equal(state(definition, "Route Hand Over").Default, "Hand Over Session");
  for (const relay of [placed, unplaced]) {
    assert.equal(relay.Resource, "arn:aws:states:::aws-sdk:sfn:startExecution");
    assert.match(JSON.stringify(relay.Parameters), /-relay-/);
    assert.match(JSON.stringify(relay.Parameters), /"sessionId\.\$":"\$\.request\.sessionId"/);
    assert.equal(relay.Next, "Handed Over");
    assert.equal(relay.Catch?.[0]?.Next, "Watchdog Stop Failing");
  }
  assert.match(JSON.stringify(placed.Parameters), /"slot\.\$"/);
  assert.ok(!JSON.stringify(unplaced.Parameters).includes('"slot.$"'), "an unplaced relay must not name a slot");
  assert.equal(state(definition, "Handed Over").End, true);
});

test("a placed session is probed on its slot; a request with no slot is probed as before", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Host Still Running").Choices?.[0]?.Next, "Route Probe Command");
  const route = state(definition, "Route Probe Command");
  assert.equal(route.Choices?.[0]?.Next, "Send Placed Probe");
  assert.equal(route.Default, "Send Structured Probe");
  const placed = state(definition, "Send Placed Probe");
  assert.match(JSON.stringify(placed.Parameters), /SPAWNPOINT_SLOT=\{\} PROBE_FORMAT=json/);
  assert.equal(placed.Next, state(definition, "Send Structured Probe").Next);
  assert.equal(placed.Catch?.[0]?.Next, state(definition, "Send Structured Probe").Catch?.[0]?.Next);
});

test("the host's memory is published after the observation, and never fails or counts as a probe", async () => {
  const definition = await loadDefinition();
  const gate = state(definition, "Has Memory Reading");
  assert.deepEqual(gate.Choices?.map((choice) => [choice.Variable, choice.IsPresent, choice.Next]), [["$.observed.probe.memory.usedPercent", true, "Publish Memory Reading"]]);
  assert.equal(gate.Default, "Count Successful Probe", "a host that reports no memory is counted as before");
  assert.equal(state(definition, "Extract Player Count").Parameters?.observed && (state(definition, "Extract Player Count").Parameters?.observed as Record<string, unknown>)["probe.$"], "$.observed.probe");

  const publish = state(definition, "Publish Memory Reading");
  assert.equal(publish.Resource, "arn:aws:states:::aws-sdk:cloudwatch:putMetricData");
  const parameters = publish.Parameters as { Namespace: string; MetricData: Array<Record<string, unknown>> };
  assert.equal(parameters.Namespace, "Spawnpoint/Host");
  assert.equal(parameters.MetricData[0]?.MetricName, "MemoryUsedPercent");
  assert.deepEqual(parameters.MetricData[0]?.Dimensions, [{ Name: "InstanceId", "Value.$": "$.request.instanceId" }]);
  assert.equal(parameters.MetricData[0]?.["Value.$"], "$.observed.probe.memory.usedPercent");
  assert.equal(publish.Next, "Count Successful Probe");
  assert.deepEqual(publish.Catch?.map((caught) => [caught.ErrorEquals, caught.Next]), [[["States.ALL"], "Count Successful Probe"]], "a failed publish is not a probe failure");
});
