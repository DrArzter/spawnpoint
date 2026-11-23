import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  SecondsPath?: string;
  Choices?: Array<Record<string, unknown>>;
};

type Definition = {
  StartAt: string;
  QueryLanguage: string;
  States: Record<string, State>;
};

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/start-server.asl.json", import.meta.url);
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

test("start workflow is a closed, reachable graph", async () => {
  const definition = await loadDefinition();
  const states = definition.States;
  const targets = new Set<string>([definition.StartAt]);

  for (const state of Object.values(states)) {
    if (state.Next) targets.add(state.Next);
    if (state.Default) targets.add(state.Default);
    for (const choice of state.Choices ?? []) {
      for (const target of choiceTargets(choice)) targets.add(target);
    }
  }

  for (const target of targets) assert.ok(states[target], `missing target state: ${target}`);

  const reachable = new Set<string>();
  const queue = [definition.StartAt];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    const state = states[name];
    assert.ok(state, `reachable state is missing: ${name}`);
    const outgoing = [state.Next, state.Default].filter((value): value is string => Boolean(value));
    for (const choice of state.Choices ?? []) outgoing.push(...choiceTargets(choice));
    queue.push(...outgoing);
  }

  assert.deepEqual([...reachable].sort(), Object.keys(states).sort());
});

test("start workflow waits in Step Functions and calls EC2 and SSM directly", async () => {
  const definition = await loadDefinition();
  const states = Object.values(definition.States);
  const resources = states.flatMap((state) => state.Resource ?? []);

  assert.equal(definition.QueryLanguage, "JSONPath");
  assert.ok(states.filter((state) => state.Type === "Wait").length >= 3);
  assert.ok(states.filter((state) => state.Type === "Wait").every((state) => state.SecondsPath));
  assert.ok(resources.includes("arn:aws:states:::aws-sdk:ec2:startInstances"));
  assert.ok(resources.includes("arn:aws:states:::aws-sdk:ec2:describeInstances"));
  assert.ok(resources.includes("arn:aws:states:::aws-sdk:ssm:describeInstanceInformation"));
  assert.ok(resources.includes("arn:aws:states:::aws-sdk:ssm:sendCommand"));
  assert.ok(resources.includes("arn:aws:states:::aws-sdk:ssm:getCommandInvocation"));
  assert.ok(resources.every((resource) => !resource.includes(":lambda:")));
});

test("every polling loop is bounded and ready follows SSM success", async () => {
  const definition = await loadDefinition();
  const serialized = JSON.stringify(definition);

  for (const counter of ["maxInstancePolls", "maxSsmPolls", "maxCommandPolls"]) {
    assert.match(serialized, new RegExp(counter));
  }

  const commandChoice = definition.States["Session Command Complete"];
  assert.ok(commandChoice);
  const success = commandChoice.Choices?.find((choice) => choice.StringEquals === "Success");
  assert.equal(success?.Next, "Read Session Summary");
  assert.equal(definition.States["Read Session Summary"]?.Next, "Ready");
  const ready = definition.States.Ready;
  assert.ok(ready);
  assert.equal(ready.End, true);
});

function hostParameters(definition: Awaited<ReturnType<typeof loadDefinition>>, name: string): Record<string, unknown> {
  const parameters = (definition.States[name] as { Parameters?: { DocumentName?: string; Parameters?: Record<string, unknown> } } | undefined)?.Parameters;
  assert.equal(parameters?.DocumentName, "spawnpoint-start-session", `${name} sends the start document`);
  return parameters?.Parameters ?? {};
}

// ADR-0082: the host step is the spawnpoint-start-session document. The request
// reaches it only as named parameters, which SSM checks against the document's
// patterns before any shell reads them; the core Terraform test checks its script.
test("the host step names the world as a document parameter, never inside a shell line", async () => {
  const definition = await loadDefinition();
  assert.deepEqual(hostParameters(definition, "Start Session Command"), { "worldId.$": "States.Array($.request.worldId)" });
  assert.doesNotMatch(JSON.stringify(definition), /commands\.\$|AWS-RunShellScript/);
});

// The address used to be a request field echoed back as the result, which was
// right only while every world used the overlay: a public address does not
// exist before the instance starts, so nobody can supply it. Now the host's
// session summary is the one JSON document on stdout, the machine parses the
// whole of it, and Ready carries the strategy's answer.
test("the address is the host's answer, carried by the machine, never echoed from the request", async () => {
  const definition = await loadDefinition();
  const states = definition.States as Record<string, any>;
  const summary = states["Read Session Summary"];
  assert.equal(summary.Type, "Pass");
  assert.equal(summary.Parameters["summary.$"], "States.StringToJson($.observed.invocation.StandardOutputContent)");
  assert.equal(summary.ResultPath, "$.session");
  const ready = states.Ready;
  assert.equal(ready.Parameters["connectionAddress.$"], "$.session.summary.connection_address");
  assert.equal(ready.Parameters["connectivity.$"], "$.session.summary.connectivity");
  assert.equal(ready.Parameters["connectionHost.$"], "$.session.summary.connection_host");
  assert.ok(!JSON.stringify(definition).includes("$.request.connectionAddress"), "no state may echo a caller's address");

  const example = JSON.parse(await readFile(new URL("../../workflows/start-server.input.example.json", import.meta.url), "utf8"));
  assert.ok(!("connectionAddress" in example), "the request carries no address to echo");
});

test("a placed session's command carries its slot, and a request with no slot runs the command it always ran", async () => {
  const definition = await loadDefinition();
  const route = definition.States["Route Session Command"];
  assert.ok(route);
  assert.equal(route.Choices?.[0]?.Next, "Start Fleet Session Command");
  assert.equal(route.Choices?.[1]?.Variable, "$.request.slot");
  assert.equal(route.Choices?.[1]?.Next, "Start Placed Session Command");
  assert.equal(route.Default, "Start Session Command");
  const placed = { "worldId.$": "States.Array($.request.worldId)", "slot.$": "States.Array(States.Format('{}', $.request.slot))" };
  assert.deepEqual(hostParameters(definition, "Start Placed Session Command"), placed);
  // A launched host may register with SSM before its bootstrap finishes; the document waits for it.
  assert.deepEqual(hostParameters(definition, "Start Fleet Session Command"), { ...placed, waitForFleet: ["true"] });
  for (const name of ["Start Placed Session Command", "Start Fleet Session Command"]) {
    assert.equal(definition.States[name]?.Next, definition.States["Start Session Command"]?.Next);
  }
});
