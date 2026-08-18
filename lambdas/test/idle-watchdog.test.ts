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
  const url = new URL("../../workflows/idle-watchdog.asl.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Definition;
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

test("every transition targets an existing state", async () => {
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

test("a failed probe never counts as empty", async () => {
  const definition = await loadDefinition();

  // Fail-closed per ADR-0006: the failure path resets the empty streak to a
  // literal zero and counts the failure instead.
  const failure = definition.States["Count Probe Failure"];
  const counters = failure.Parameters?.counters as Record<string, unknown>;
  assert.equal(counters.empty, 0);
  assert.match(String(counters["probeFailures.$"]), /MathAdd\(\$\.counters\.probeFailures, 1\)/);

  // Both probe failure entries route through the failure counter, never the empty one.
  const sendProbe = definition.States["Send Probe"];
  assert.equal(sendProbe.Catch?.[0].Next, "Count Probe Failure");
  const route = definition.States["Route Probe Result"];
  assert.equal(route.Default, "Count Probe Failure");
});

test("players online resets the empty streak, and exit code 3 is the occupied signal", async () => {
  const definition = await loadDefinition();
  const route = definition.States["Route Probe Result"];
  const occupied = route.Choices?.find((candidate) => JSON.stringify(candidate).includes('"NumericEquals":3'));
  assert.equal(occupied?.Next, "Session Occupied");

  const counters = definition.States["Session Occupied"].Parameters?.counters as Record<string, unknown>;
  assert.equal(counters.empty, 0);
});

test("the stop is the verified stop workflow, run synchronously, and a refusal resumes watching", async () => {
  const definition = await loadDefinition();
  for (const name of ["Stop Idle Session", "Stop Capped Session"]) {
    const stop = definition.States[name];
    assert.equal(stop.Resource, "arn:aws:states:::states:startExecution.sync:2");
    assert.equal(stop.Catch?.[0].Next, "Stop Refused");
  }

  // A refused stop goes back to watching, not to a terminal state — the
  // legitimate case is players racing back in during the empty streak.
  const refusalLimit = definition.States["Stop Refusal Limit Reached"];
  assert.equal(refusalLimit.Default, "Wait Between Checks");
});

test("an externally stopped host ends the watchdog successfully", async () => {
  const definition = await loadDefinition();
  const running = definition.States["Host Still Running"];
  assert.equal(running.Default, "Host Stopped Externally");
  const terminal = definition.States["Host Stopped Externally"];
  assert.equal(terminal.Type, "Pass");
  assert.equal(terminal.End, true);
});

test("every loop is bounded and every timing is injected", async () => {
  const serialized = JSON.stringify(await loadDefinition());
  for (const bound of [
    "emptyChecksRequired",
    "maxTotalChecks",
    "maxConsecutiveProbeFailures",
    "maxStopRefusals",
    "maxProbePolls",
  ]) {
    assert.match(serialized, new RegExp(bound));
  }
  assert.doesNotMatch(serialized, /"Seconds"\s*:/, "Wait states must inject SecondsPath, never hard-code Seconds");
});

test("blindness and repeated stop failure fail loudly instead of stopping the host", async () => {
  const definition = await loadDefinition();
  assert.equal(definition.States["Watchdog Blind"].Type, "Fail");
  assert.equal(definition.States["Watchdog Stop Failing"].Type, "Fail");
  assert.match(
    JSON.stringify(definition.States["Watchdog Blind"]),
    /left running/,
  );
});
