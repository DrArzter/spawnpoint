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
  const toStop = choice.Choices?.filter((candidate) => candidate.Next === "Stop Instance") ?? [];
  const playerRace = choice.Choices?.find((candidate) => JSON.stringify(candidate).includes('"NumericEquals":3'));

  assert.equal(toStop.length, 1);
  assert.match(JSON.stringify(toStop[0]), /"StringEquals":"Success"/);
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

test("SSM Success alone never stops the host; the verified-archive line does (ADR-0073)", async () => {
  const definition = await loadDefinition();
  const choice = definition.States["Stop Command Complete"];
  assert.ok(choice);
  const toStop = choice.Choices?.find((candidate) => candidate.Next === "Stop Instance") as Record<string, any>;
  const [status, line] = toStop.And as [Record<string, any>, Record<string, any>];

  assert.deepEqual(status, { Variable: "$.observed.invocation.Status", StringEquals: "Success" });
  assert.deepEqual(
    (line.Or as Array<Record<string, string>>).map((candidate) => [candidate.Variable, candidate.StringMatches]),
    [
      ["$.observed.invocation.StandardOutputContent", "*result=session_stopped_and_backed_up*"],
      ["$.observed.invocation.StandardOutputContent", "*result=already_stopped_and_backed_up*"],
    ],
  );
  assert.equal(
    choice.Choices?.some((candidate) => candidate.StringEquals === "Success"),
    false,
    "a bare Success, such as an old already_stopped, falls to Session Stop Failed",
  );
  assert.equal(choice.Default, "Session Stop Failed");

  const elsewhere = choice.Choices?.find((candidate) => JSON.stringify(candidate).includes('"NumericEquals":6'));
  assert.equal(elsewhere?.Next, "World Not On Host");
  assert.equal(definition.States["World Not On Host"]?.Type, "Fail");
  assert.match(JSON.stringify(definition.States["World Not On Host"]), /Spawnpoint\.WorldNotOnHost/);
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

test("a placed session is stopped in the project its slot names; a request with no slot runs the command it always ran", async () => {
  const definition = await loadDefinition();
  const route = definition.States["Route Stop Command"];
  assert.ok(route);
  assert.equal(route.Choices?.[0]?.Variable, "$.request.slot");
  assert.equal(route.Choices?.[0]?.Next, "Stop Placed Session Command");
  assert.equal(route.Default, "Stop Session Command");
  const placed = JSON.stringify(definition.States["Stop Placed Session Command"]);
  assert.match(placed, /WORLD_ID=\{\} SPAWNPOINT_SLOT=\{\} SPAWNPOINT_STOP_PLAYERS=\{\} \/srv\/spawnpoint\/app\/server\/scripts\/stop-session\.sh', \$\.request\.worldId, \$\.request\.slot, \$\.request\.players\)/);
  assert.equal(definition.States["Stop Placed Session Command"]?.Next, definition.States["Stop Session Command"]?.Next);
});

test("a stop refuses with players online unless its request asks to disconnect them", async () => {
  const definition = await loadDefinition();
  const initialize = JSON.stringify(definition.States["Initialize"]);
  assert.match(initialize, /"players":"refuse"/, "a request that names no policy refuses");
  assert.equal(definition.States["Apply Request Defaults"]?.Next, "Route Players Policy");
  const route = definition.States["Route Players Policy"];
  assert.equal(route?.Default, "Unknown Players Policy", "only the two known words reach the host's shell");
  assert.match(JSON.stringify(route), /"StringEquals":"refuse".*"StringEquals":"disconnect"/);
  assert.equal(route?.Choices?.[0]?.Next, "Describe Initial Instance");
  assert.equal(definition.States["Unknown Players Policy"]?.Type, "Fail");
  for (const name of ["Stop Placed Session Command", "Stop Session Command"]) {
    assert.match(JSON.stringify(definition.States[name]), /SPAWNPOINT_STOP_PLAYERS=\{\}/);
  }
});
