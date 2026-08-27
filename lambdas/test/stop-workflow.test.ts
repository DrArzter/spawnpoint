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
  assert.ok(choice);
  const success = choice.Choices?.find((candidate) => candidate.StringEquals === "Success");
  const playerRace = choice.Choices?.find((candidate) => JSON.stringify(candidate).includes("ResponseCode"));

  assert.equal(success?.Next, "Stop Instance");
  assert.equal(playerRace?.Next, "Players Online");
  assert.match(JSON.stringify(definition.States["Players Online"]), /Spawnpoint\.PlayersOnline/);
  assert.equal(choice.Default, "Session Stop Failed");
  const stopInstance = definition.States["Stop Instance"];
  assert.ok(stopInstance);
  assert.equal(
    stopInstance.Resource,
    "arn:aws:states:::aws-sdk:ec2:stopInstances",
  );
  assert.match(
    JSON.stringify(definition.States["Session Stop Failed"]),
    /EC2 remains running/,
  );
});

test("the host stops only when nothing else on it is being played", async () => {
  const definition = await loadDefinition();
  const choice = definition.States["Stop Command Complete"];
  const byResponseCode = (code: number) =>
    choice?.Choices?.find((candidate) => JSON.stringify(candidate).includes(`"NumericEquals":${code}`));

  // The session's own stop succeeded in all three cases; what differs is
  // whether the instance may sleep. Exit codes rather than parsed output, the
  // same contract the player-race refusal already uses.
  assert.equal(byResponseCode(4)?.Next, "Host Still Busy");
  assert.equal(byResponseCode(5)?.Next, "Host Activity Unknown");

  const busy = definition.States["Host Still Busy"];
  assert.equal(busy?.Type, "Pass", "a session stopped beside a busy neighbour is a success, not a failure");
  assert.match(JSON.stringify(busy), /session_stopped_host_busy/);
  assert.doesNotMatch(JSON.stringify(busy), /stopInstances/);

  const unknown = definition.States["Host Activity Unknown"];
  assert.equal(unknown?.Type, "Fail", "an unreadable answer must be loud, not silently treated as idle");
  assert.match(JSON.stringify(unknown), /Spawnpoint\.HostActivityUnknown/);
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
  assert.ok(initialChoice);
  const stopped = initialChoice.Choices?.find((candidate) => candidate.StringEquals === "stopped");

  assert.equal(stopped?.Next, "Already Stopped");
  const alreadyStopped = definition.States["Already Stopped"];
  assert.ok(alreadyStopped);
  assert.equal(alreadyStopped.End, true);
});
