import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ADR-0102, step 3: Spot for a cold launched host, with the on-demand fallback.

type Rule = Record<string, unknown>;
type State = {
  Type: string;
  Next?: string;
  Default?: string;
  Resource?: string;
  ResultPath?: string | null;
  ResultSelector?: Record<string, unknown>;
  Parameters?: Record<string, any>;
  Choices?: Rule[];
  Catch?: Array<{ ErrorEquals: string[]; Next: string }>;
};
type Definition = { States: Record<string, State> };

async function load(spot: string, sessionVolume = "enabled"): Promise<Definition> {
  let template = await readFile(new URL("../../workflows/start-server-v2.asl.json.tftpl", import.meta.url), "utf8");
  const values = { allowed_instance_types: JSON.stringify(["m7i.*"]), spot, session_volume: sessionVolume };
  for (const [key, value] of Object.entries(values)) template = template.replaceAll(`\${${key}}`, value);
  return JSON.parse(template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource")) as Definition;
}

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

// Enough of JSONPath for the paths these choices read: `$.a.b[0].c`.
function read(input: unknown, path: string): unknown {
  let current: unknown = input;
  for (const part of path.replace(/^\$\.?/, "").split(/\.|(?=\[)/).filter(Boolean)) {
    if (current === null || typeof current !== "object") return undefined;
    const index = /^\[(\d+)\]$/.exec(part);
    current = index ? (current as unknown[])[Number(index[1])] : (current as Record<string, unknown>)[part];
  }
  return current;
}

// Enough of the Choice rules for these states. A comparison on a missing value fails, as in Step Functions.
function matches(rule: Rule, input: unknown): boolean {
  if (rule.And) return (rule.And as Rule[]).every((inner) => matches(inner, input));
  if (rule.Or) return (rule.Or as Rule[]).some((inner) => matches(inner, input));
  const value = read(input, rule.Variable as string);
  if ("IsPresent" in rule) return (value !== undefined) === rule.IsPresent;
  if (value === undefined) throw new Error(`States.Runtime: ${rule.Variable as string} is missing`);
  if ("StringEquals" in rule) return value === rule.StringEquals;
  if ("BooleanEquals" in rule) return value === rule.BooleanEquals;
  throw new Error(`unsupported rule ${JSON.stringify(rule)}`);
}

function choose(definition: Definition, name: string, input: unknown): string {
  const choice = state(definition, name);
  return choice.Choices!.find((rule) => matches(rule, input))?.Next as string ?? choice.Default!;
}

function input(definition: Definition, overrides: { policy?: string; spot?: boolean } = {}) {
  const initial = state(definition, "Initialize").Parameters!;
  return {
    request: { policy: overrides.policy ?? "cold" },
    sessionVolume: { mode: initial.sessionVolume.mode },
    spot: { mode: initial.spot.mode },
    placement: { placement: { kind: "launch", requirements: { memoryMiB: 8192, vcpu: 2 }, spot: overrides.spot ?? true } },
  };
}

test("off by default: every launch is the on-demand request it always was", async () => {
  const definition = await load("disabled");
  assert.equal(choose(definition, "Route Launch Market", input(definition)), "Launch Host");
  const launch = state(definition, "Launch Host");
  assert.deepEqual(launch.Parameters!.TargetCapacitySpecification, { TotalTargetCapacity: 1, DefaultTargetCapacityType: "on-demand" });
  assert.deepEqual(launch.Parameters!.OnDemandOptions, { AllocationStrategy: "lowest-price", SingleInstanceType: true });
  assert.ok(!("SpotOptions" in launch.Parameters!));
  assert.equal(launch.ResultSelector!.market, "on-demand");
});

test("on, a cold session of a spot game asks for Spot; any other session, or no session volume, stays on demand", async () => {
  const on = await load("enabled");
  assert.equal(choose(on, "Route Launch Market", input(on)), "Launch Spot Host");
  assert.equal(choose(on, "Route Launch Market", input(on, { policy: "warm" })), "Launch Host", "a warm host must be stoppable");
  assert.equal(choose(on, "Route Launch Market", input(on, { spot: false })), "Launch Host", "a game without capabilities.spot");

  const noVolume = await load("enabled", "disabled");
  assert.equal(choose(noVolume, "Route Launch Market", input(noVolume)), "Launch Host", "Spot without the session volume is refused");
});

test("the Spot request is the on-demand one with Spot as the target, price-capacity-optimized and no maximum price", async () => {
  const definition = await load("enabled");
  const spot = state(definition, "Launch Spot Host");
  const demand = state(definition, "Launch Host");
  assert.equal(spot.Resource, demand.Resource);
  assert.equal(spot.Parameters!.Type, "instant");
  assert.deepEqual(spot.Parameters!.LaunchTemplateConfigs, demand.Parameters!.LaunchTemplateConfigs);
  assert.deepEqual(spot.Parameters!.TagSpecifications, demand.Parameters!.TagSpecifications);
  assert.deepEqual(spot.Parameters!.TargetCapacitySpecification, { TotalTargetCapacity: 1, DefaultTargetCapacityType: "spot" });
  assert.deepEqual(spot.Parameters!.SpotOptions, { AllocationStrategy: "price-capacity-optimized" });
  assert.ok(!JSON.stringify(spot.Parameters).includes("MaxPrice"));
  assert.equal(spot.ResultSelector, undefined, "an answer without an instance must reach the choice, not fail a selector");
  assert.equal(spot.Next, "Route Spot Answer");
});

test("Spot that answers is adopted as spot; a capacity shortfall falls back to on demand; anything else refuses", async () => {
  const definition = await load("enabled");
  const answered = { spotLaunch: { Instances: [{ InstanceIds: ["i-spot"], InstanceType: "r7i.large", Lifecycle: "spot" }], Errors: [] } };
  assert.equal(choose(definition, "Route Spot Answer", answered), "Adopt Spot Host");
  const adopt = state(definition, "Adopt Spot Host");
  assert.deepEqual(adopt.Parameters, {
    "instanceId.$": "$.spotLaunch.Instances[0].InstanceIds[0]",
    "instanceType.$": "$.spotLaunch.Instances[0].InstanceType",
    market: "spot",
  });
  assert.equal(adopt.ResultPath, "$.launched");
  assert.equal(adopt.Next, "Describe Launched Host Shape", "a Spot host is recorded and reserved like any launched host");

  for (const code of ["InsufficientInstanceCapacity", "UnfulfillableCapacity", "InsufficientCapacity"]) {
    const short = { spotLaunch: { Instances: [], Errors: [{ ErrorCode: code, ErrorMessage: "no capacity" }] } };
    assert.equal(choose(definition, "Route Spot Answer", short), "Launch Host", code);
  }
  const refused = { spotLaunch: { Instances: [], Errors: [{ ErrorCode: "UnauthorizedOperation" }] } };
  assert.equal(choose(definition, "Route Spot Answer", refused), "Spot Launch Refused");
  assert.equal(choose(definition, "Route Spot Answer", { spotLaunch: {} }), "Spot Launch Refused");
  assert.equal(state(definition, "Spot Launch Refused").Next, "Placement Unavailable");

  const caught = state(definition, "Launch Spot Host").Catch!;
  assert.equal(caught[0]!.Next, "Launch Host", "a thrown capacity error falls back as well");
  assert.ok(caught[0]!.ErrorEquals.every((error) => /Capacity/.test(error)));
  assert.deepEqual(caught.at(-1), { ErrorEquals: ["States.ALL"], ResultPath: "$.placementFailure", Next: "Placement Unavailable" });
});

test("the host records the market it came from", async () => {
  const definition = await load("enabled");
  assert.equal(state(definition, "Register Launched Host").Parameters!.Payload["market.$"], "$.launched.market");
  assert.equal(state(definition, "Apply Request Defaults").Parameters!["spot.$"], "$.spot");
});
