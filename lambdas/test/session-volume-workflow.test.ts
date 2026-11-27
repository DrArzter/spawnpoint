import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ADR-0102, step 2b: the session volume in the start and stop workflows.

type State = {
  Type: string;
  Next?: string;
  Default?: string;
  Resource?: string;
  InputPath?: string;
  ResultPath?: string | null;
  Parameters?: Record<string, unknown>;
  Choices?: Array<Record<string, unknown>>;
  Catch?: Array<{ ErrorEquals: string[]; Next: string }>;
};

type Definition = { StartAt: string; States: Record<string, State> };

async function load(name: string, values: Record<string, string> = {}): Promise<Definition> {
  let template = await readFile(new URL(`../../workflows/${name}`, import.meta.url), "utf8");
  for (const [key, value] of Object.entries({ allowed_instance_types: JSON.stringify(["m7i.*"]), ...values })) {
    template = template.replaceAll(`\${${key}}`, value);
  }
  return JSON.parse(template.replaceAll(/\$\{[^}]+\}/g, "arn:aws:test:eu-central-1:123456789012:resource")) as Definition;
}

const TAGS = { session_volume_managed_by: "spawnpoint-session-volume", session_volume_session_tag: "SessionId" };

function state(definition: Definition, name: string): State {
  const result = definition.States[name];
  assert.ok(result, `missing state: ${name}`);
  return result;
}

// Every path out of a set of states, so a test can prove where a chain may end.
function exits(definition: Definition, names: string[]): Set<string> {
  const inside = new Set(names);
  const out = new Set<string>();
  for (const name of names) {
    const s = state(definition, name);
    const targets = [s.Next, s.Default, ...(s.Choices ?? []).map((c) => c.Next as string), ...(s.Catch ?? []).map((c) => c.Next)];
    for (const target of targets) if (target && !inside.has(target)) out.add(target);
  }
  return out;
}

const RELEASE = [
  "Route Session Volume Release",
  "Find Session Volume",
  "Route Found Session Volume",
  "Unmount Session Volume",
  "Wait Before Unmount Poll",
  "Get Unmount Command",
  "Unmount Complete",
  "Count Unmount Poll",
  "Unmount Poll Limit Reached",
  "Detach Session Volume",
  "Wait Before Detach Poll",
  "Describe Detached Session Volume",
  "Session Volume Detached",
  "Count Detach Poll",
  "Detach Poll Limit Reached",
  "Delete Session Volume",
];

test("off is the default the template carries, and off skips straight to the old path", async () => {
  const start = await load("start-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "disabled", session_volume_size_gib: "30" });
  const initial = state(start, "Initialize").Parameters!.sessionVolume as Record<string, unknown>;
  assert.equal(initial.mode, "disabled");
  assert.equal(initial.volumeId, "", "V1 receives an empty id and runs the command it always ran");
  assert.equal(state(start, "Adopt Placement").Next, "Route Session Volume");
  assert.equal(state(start, "Route Session Volume").Default, "Start Accepted V1");
  assert.equal(state(start, "Route Session Volume Release After Failed Start").Default, "Mark Compensated Session Stopped");

  const stop = await load("stop-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "disabled" });
  assert.equal(state(stop, "Stop Accepted V1").Next, "Mark Session Stopped");
  assert.equal(state(stop, "Route Session Volume Release").Default, "Release Placement");
});

test("only a cold fleet session with the switch on gets a volume", async () => {
  const start = await load("start-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled", session_volume_size_gib: "30" });
  const [choice] = state(start, "Route Session Volume").Choices!;
  assert.deepEqual(choice!.And, [
    { Variable: "$.sessionVolume.mode", StringEquals: "enabled" },
    { Variable: "$.request.placement", StringEquals: "fleet" },
    { Variable: "$.request.policy", StringEquals: "cold" },
  ]);
  assert.equal(choice!.Next, "Describe Session Host Zone");
  // The switch is rendered, never read from the request a caller can shape.
  assert.equal((state(start, "Apply Request Defaults").Parameters as Record<string, string>)["sessionVolume.$"], "$.sessionVolume");
});

test("the volume is created tagged in the host's zone, attached by slot, and handed to V1", async () => {
  const start = await load("start-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled", session_volume_size_gib: "30" });
  const create = state(start, "Create Session Volume").Parameters!;
  assert.equal(create["AvailabilityZone.$"], "$.sessionVolume.host.zone");
  assert.equal(create["Size.$"], "States.StringToJson('30')");
  assert.equal(create.VolumeType, "gp3");
  assert.equal(create.Encrypted, true);
  assert.deepEqual((create.TagSpecifications as Array<{ ResourceType: string; Tags: unknown[] }>)[0], {
    ResourceType: "volume",
    Tags: [
      { Key: "ManagedBy", Value: "spawnpoint-session-volume" },
      { Key: "SessionId", "Value.$": "$.request.sessionId" },
      { Key: "WorldId", "Value.$": "$.request.worldId" },
    ],
  });

  const device = state(start, "Attach Session Volume").Parameters!["Device.$"] as string;
  assert.match(device, /^States\.ArrayGetItem\(States\.Array\('\/dev\/sdf', .*'\/dev\/sdz'\), \$\.request\.placed\.slot\)$/);
  assert.equal(state(start, "Session Volume Available").Choices![1]!.Next, "Attach Session Volume");
  assert.equal(state(start, "Session Volume Attached").Choices![0]!.Next, "Adopt Session Volume");
  assert.equal(state(start, "Adopt Session Volume").InputPath, "$.sessionVolume.created.volumeId");
  assert.equal(state(start, "Adopt Session Volume").ResultPath, "$.sessionVolume.volumeId");
  assert.equal(state(start, "Adopt Session Volume").Next, "Start Accepted V1");
  const input = state(start, "Start Accepted V1").Parameters!.Input as Record<string, string>;
  assert.equal(input["sessionVolumeId.$"], "$.sessionVolume.volumeId");
});

test("a volume that cannot be made ready fails the start into its compensation", async () => {
  const start = await load("start-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled", session_volume_size_gib: "30" });
  const chain = [
    "Describe Session Host Zone",
    "Route Moved Session Volume",
    "Adopt Moved Session Volume",
    "Create Session Volume",
    "Wait Before Created Volume Poll",
    "Describe Created Session Volume",
    "Session Volume Available",
    "Count Created Volume Poll",
    "Created Volume Poll Limit Reached",
    "Attach Session Volume",
    "Wait Before Attached Volume Poll",
    "Describe Attached Session Volume",
    "Session Volume Attached",
    "Count Attached Volume Poll",
    "Attached Volume Poll Limit Reached",
    "Adopt Session Volume",
    "Session Volume Unavailable",
  ];
  assert.deepEqual([...exits(start, chain)].sort(), ["Begin Compensating Stop", "Start Accepted V1"]);
  for (const name of chain) {
    for (const handler of state(start, name).Catch ?? []) assert.equal(handler.Next, "Begin Compensating Stop", name);
  }
  assert.equal(state(start, "Session Volume Unavailable").ResultPath, "$.startFailure");
});

test("the release never fails a verified stop: every way out goes on to release the placement", async () => {
  const stop = await load("stop-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled" });
  assert.deepEqual([...exits(stop, RELEASE)], ["Release Placement"]);

  const start = await load("start-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled", session_volume_size_gib: "30" });
  const compensation = RELEASE.map((name) => `${name} After Failed Start`);
  assert.deepEqual([...exits(start, compensation)], ["Mark Compensated Session Stopped"]);
  assert.equal(state(start, "Stop Accepted V1").Next, "Route Session Volume Release After Failed Start");
});

test("the release finds the volume by its session tag and unmounts only on a host that keeps running", async () => {
  const stop = await load("stop-server-v2.asl.json.tftpl", { ...TAGS, session_volume: "enabled" });
  assert.deepEqual(state(stop, "Find Session Volume").Parameters!.Filters, [
    { Name: "tag:ManagedBy", Values: ["spawnpoint-session-volume"] },
    { Name: "tag:SessionId", "Values.$": "States.Array($.request.sessionId)" },
  ]);
  const routes = state(stop, "Route Found Session Volume");
  assert.deepEqual(routes.Choices!.map((choice) => choice.Next), ["Release Placement", "Delete Session Volume", "Unmount Session Volume"]);
  assert.equal(routes.Choices![2]!.Variable, "$.hostStop.Output.status");
  assert.equal(routes.Choices![2]!.StringEquals, "session_stopped_host_busy");
  assert.equal(routes.Default, "Detach Session Volume");
  const unmount = state(stop, "Unmount Session Volume").Parameters!;
  assert.equal(unmount.DocumentName, "spawnpoint-unmount-session-volume");
  assert.deepEqual(unmount.Parameters, { "worldId.$": "States.Array($.request.worldId)" });
  assert.equal(state(stop, "Unmount Complete").Choices![0]!.Next, "Detach Session Volume");
  assert.equal(state(stop, "Session Volume Detached").Choices![0]!.Next, "Delete Session Volume");
});

test("V1 passes a session volume to the start document only when it has one", async () => {
  const v1 = await load("start-server.asl.json");
  const [withVolume, fleet] = state(v1, "Route Session Command").Choices!;
  assert.equal(withVolume!.Next, "Start Fleet Session Command On Volume");
  assert.equal(fleet!.Next, "Start Fleet Session Command");
  assert.deepEqual((withVolume!.And as unknown[]).slice(2), [
    { Variable: "$.request.sessionVolumeId", IsPresent: true },
    { Not: { Variable: "$.request.sessionVolumeId", StringEquals: "" } },
  ]);
  const onVolume = state(v1, "Start Fleet Session Command On Volume").Parameters!;
  assert.equal((onVolume.Parameters as Record<string, unknown>)["sessionVolumeId.$"], "States.Array($.request.sessionVolumeId)");
  const { sessionVolumeId: _omit, ["sessionVolumeId.$"]: _also, ...rest } = onVolume.Parameters as Record<string, unknown>;
  assert.deepEqual(rest, state(v1, "Start Fleet Session Command").Parameters!.Parameters);
  assert.equal(state(v1, "Start Fleet Session Command On Volume").Next, "Wait Before Command Poll");
});
