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
  assert.equal(success?.Next, "Ready");
  const ready = definition.States.Ready;
  assert.ok(ready);
  assert.equal(ready.End, true);
});
