import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withoutOperationRecord } from "./support/operation-record-states.ts";

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
  return withoutOperationRecord(JSON.parse(rendered) as Definition);
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
  assert.equal(state(definition, "Begin Stopping Session").Next, "Find Placement");
  // ADR-0054: a stop is told a session and finds its host and slot itself.
  // ADR-0073: only a configured world falls back to the requested instance.
  assert.equal((state(definition, "Find Placement") as Record<string, any>).Parameters.Payload.action, "findPlacement");
  assert.equal(state(definition, "Find Placement").Next, "Route Found Placement");
  assert.equal(state(definition, "Find Placement").Catch?.[0]?.Next, "Placement Lookup Failed");
  assert.equal(state(definition, "Route Found Placement").Choices?.[0]?.Next, "Route Unplaced Session");
  assert.equal(state(definition, "Route Found Placement").Default, "Adopt Found Placement");
  assert.equal(state(definition, "Route Unplaced Session").Default, "Adopt Requested Host");
  assert.deepEqual((state(definition, "Adopt Found Placement") as Record<string, any>).Parameters, { "hostId.$": "$.placementLookup.placement.hostId", "slot.$": "$.placementLookup.placement.slot" });
  assert.deepEqual((state(definition, "Adopt Requested Host") as Record<string, any>).Parameters, { "hostId.$": "$.request.instanceId", slot: "" });
  assert.equal(state(definition, "Adopt Found Placement").Next, "Stop Accepted V1");
  assert.equal(state(definition, "Adopt Requested Host").Next, "Stop Accepted V1");
  const nested = (state(definition, "Stop Accepted V1") as Record<string, any>).Parameters.Input as Record<string, string>;
  assert.equal(nested["instanceId.$"], "$.request.placed.hostId");
  assert.equal(nested["slot.$"], "$.request.placed.slot");
  const release = (state(definition, "Release Placement") as Record<string, any>).Parameters.Payload as Record<string, unknown>;
  assert.equal(release.action, "releasePlacement");
  assert.equal(release["sessionId.$"], "$.request.sessionId");
  assert.equal("hostId.$" in release, false, "the reservation is found by session, wherever it is");
  assert.equal(state(definition, "Stop Accepted V1").Resource, "arn:aws:states:::states:startExecution.sync:2");
  // The session is marked stopped once its archive is verified; the volume is released after, before the placement.
  assert.equal(state(definition, "Stop Accepted V1").Next, "Mark Session Stopped");
  assert.equal(state(definition, "Mark Session Stopped").Next, "Close Session History");
  assert.equal(state(definition, "Close Session History").Next, "Route Session Volume Release");
  assert.equal(state(definition, "Route Session Volume Release").Default, "Release Placement");
  assert.equal(state(definition, "Release Placement").Next, "Route Emptied Host");
  assert.equal(state(definition, "Release Placement").Catch?.[0]?.Next, "Release Stop Lease");
  assert.equal(state(definition, "Release Stop Lease").Next, "Stopped");
});

// The states reachable for one serverId. A rule on the serverId is decided;
// any other rule may go either way, so every branch of it is followed.
function reachableFor(definition: Definition, serverId: string): Set<string> {
  const decide = (rule: Record<string, unknown>): boolean | undefined => {
    if (rule.Variable !== "$.request.serverId" || typeof rule.StringMatches !== "string") return undefined;
    const pattern = new RegExp(`^${rule.StringMatches.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return pattern.test(serverId);
  };
  const next = (current: State): string[] => {
    if (current.Type !== "Choice") return targets(current);
    const result: string[] = [];
    for (const choice of current.Choices ?? []) {
      const decided = decide(choice);
      if (decided === false) continue;
      result.push(choice.Next as string);
      if (decided === true) return result;
    }
    return current.Default ? [...result, current.Default] : result;
  };
  const reachable = new Set<string>();
  const queue = [definition.StartAt];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...next(state(definition, name)));
  }
  return reachable;
}

test("a fleet stop has no path to the requested host; a configured stop keeps its fallback (ADR-0073)", async () => {
  const definition = await loadDefinition();

  const fleet = reachableFor(definition, "world#minecraft-rostik-1a2b3c4d");
  assert.equal(fleet.has("Adopt Requested Host"), false);
  assert.equal(fleet.has("Adopt Found Placement"), true);
  assert.equal(fleet.has("Fleet Session Unplaced"), true);

  const configured = reachableFor(definition, "minecraft");
  assert.equal(configured.has("Adopt Requested Host"), true);
  assert.equal(configured.has("Fleet Session Unplaced"), false);

  assert.equal(state(definition, "Fleet Session Unplaced").Type, "Fail");
  assert.equal(state(definition, "Placement Lookup Failed").Type, "Fail");
});

test("an unplaced fleet session is marked stopped and its lease released before the stop fails", async () => {
  const definition = await loadDefinition();
  const route = state(definition, "Route Unplaced Session");
  assert.equal(route.Choices?.[0]?.Next, "Mark Unplaced Session Stopped");

  const mark = state(definition, "Mark Unplaced Session Stopped") as Record<string, any>;
  assert.equal(mark.Parameters.Payload.action, "markStopped");
  assert.equal(mark.Parameters.Payload["sessionId.$"], "$.request.sessionId");
  assert.equal(mark.Next, "Release Unplaced Stop Lease");

  const release = state(definition, "Release Unplaced Stop Lease") as Record<string, any>;
  assert.equal(release.Parameters.Payload.action, "releaseLease");
  assert.equal(release.Next, "Fleet Session Unplaced");
  assert.equal(state(definition, "Fleet Session Unplaced").Type, "Fail");

  // No session was placed: nothing to close in the history, no placement to release.
  const path = ["Mark Unplaced Session Stopped", "Release Unplaced Stop Lease", "Fleet Session Unplaced"];
  for (const name of path) {
    for (const target of targets(state(definition, name))) {
      assert.equal(["Close Session History", "Release Placement"].includes(target), false, `${name} leads to ${target}`);
    }
  }
});

test("a failed placement lookup is retried, then ends the stop instead of guessing a host", async () => {
  const definition = await loadDefinition();
  const lookup = state(definition, "Find Placement") as Record<string, any>;
  const lease = state(definition, "Acquire Stop Lease") as Record<string, any>;

  assert.deepEqual(lookup.Retry, lease.Retry, "the standard Lambda retry");
  assert.equal(lookup.Catch.length, 1);
  assert.equal(lookup.Catch[0].Next, "Placement Lookup Failed");
  assert.match(JSON.stringify(state(definition, "Placement Lookup Failed")), /remains stopping/);
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

test("a stop that empties a launched host starts its drain; the configured host and a host still in use are left alone", async () => {
  const definition = await loadDefinition();
  const route = state(definition, "Route Emptied Host");
  assert.equal(route.Choices?.[0]?.Next, "Release Stop Lease", "a session placed nowhere leaves no host to drain");
  assert.equal(route.Default, "Route Emptied Host State");
  const byState = state(definition, "Route Emptied Host State");
  assert.equal(byState.Choices?.[0]?.Next, "Start Drain");
  assert.equal(byState.Default, "Release Stop Lease");
  assert.match(JSON.stringify(byState.Choices?.[0]), /"draining"/);
  assert.match(JSON.stringify(byState.Choices?.[0]), /"launched"/);
  const drain = state(definition, "Start Drain") as Record<string, any>;
  assert.equal(drain.Resource, "arn:aws:states:::aws-sdk:sfn:startExecution", "the drain outlives the stop; it is not awaited");
  assert.equal(drain.Parameters.Input["hostId.$"], "$.placementRelease.host.record.hostId");
  assert.equal(drain.Next, "Release Stop Lease");
  assert.equal(drain.Catch?.[0]?.Next, "Release Stop Lease", "a drain that cannot start never fails a verified stop");
});

test("a V2 stop carries its players policy to the host stop, refusing by default", async () => {
  const definition = await loadDefinition();
  assert.match(JSON.stringify(state(definition, "Initialize")), /"players":"refuse"/);
  assert.match(JSON.stringify(state(definition, "Apply Request Defaults")), /States\.JsonMerge\(\$\.defaults, \$\.request, false\)/);
  assert.match(JSON.stringify(state(definition, "Stop Accepted V1")), /"players\.\$":"\$\.request\.players"/);
});

test("the session is marked stopped before the session volume is released, and the volume before the placement", async () => {
  const definition = await loadDefinition();
  assert.equal(state(definition, "Stop Accepted V1").Next, "Mark Session Stopped");
  assert.equal(state(definition, "Mark Session Stopped").Next, "Close Session History");
  assert.deepEqual([...new Set(targets(state(definition, "Close Session History")))], ["Route Session Volume Release"]);

  const volume = ["Route Session Volume Release", "Find Session Volume", "Route Found Session Volume", "Unmount Session Volume",
    "Wait Before Unmount Poll", "Get Unmount Command", "Unmount Complete", "Count Unmount Poll", "Unmount Poll Limit Reached",
    "Detach Session Volume", "Wait Before Detach Poll", "Describe Detached Session Volume", "Session Volume Detached",
    "Count Detach Poll", "Detach Poll Limit Reached", "Delete Session Volume"];
  for (const name of volume) {
    for (const target of targets(state(definition, name))) {
      assert.ok(volume.includes(target) || target === "Release Placement", `${name} leads to ${target}`);
    }
  }

  // Every path from Close Session History meets the volume route before Release Placement.
  const seen = new Set<string>();
  const queue = targets(state(definition, "Close Session History"));
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name) || name === "Route Session Volume Release") continue;
    seen.add(name);
    assert.notEqual(name, "Release Placement", "a path skips the volume route");
    queue.push(...targets(state(definition, name)));
  }
});
