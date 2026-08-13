import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type State = {
  Type: string;
  Next?: string;
  End?: boolean;
  Default?: string;
  Resource?: string;
  Choices?: Array<Record<string, unknown>>;
};

type Definition = {
  StartAt: string;
  States: Record<string, State>;
};

async function loadDefinition(): Promise<Definition> {
  const url = new URL("../../workflows/stop-server.asl.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Definition;
}

test("stop workflow stops EC2 only after the host command succeeds", async () => {
  const definition = await loadDefinition();
  const choice = definition.States["Stop Command Complete"];
  const success = choice.Choices?.find((candidate) => candidate.StringEquals === "Success");

  assert.equal(success?.Next, "Stop Instance");
  assert.equal(choice.Default, "Session Stop Failed");
  assert.equal(
    definition.States["Stop Instance"].Resource,
    "arn:aws:states:::aws-sdk:ec2:stopInstances",
  );
  assert.match(
    JSON.stringify(definition.States["Session Stop Failed"]),
    /EC2 remains running/,
  );
});

test("stop workflow has bounded SSM, command and EC2 polling", async () => {
  const serialized = JSON.stringify(await loadDefinition());
  for (const counter of ["maxSsmPolls", "maxCommandPolls", "maxInstancePolls"]) {
    assert.match(serialized, new RegExp(counter));
  }
});

test("already stopped is a successful idempotent result", async () => {
  const definition = await loadDefinition();
  const initialChoice = definition.States["Route Initial Instance State"];
  const stopped = initialChoice.Choices?.find((candidate) => candidate.StringEquals === "stopped");

  assert.equal(stopped?.Next, "Already Stopped");
  assert.equal(definition.States["Already Stopped"].End, true);
});
