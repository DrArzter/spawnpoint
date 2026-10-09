import assert from "node:assert/strict";
import test from "node:test";

import { notificationSubscriptionKey, parseExecutionEvent, renderNotification, type ExecutionEvent } from "../src/domain/notifications.ts";

const ARN_PREFIX = "arn:aws:states:eu-central-1:123456789012:stateMachine:";

function event(
  machine: string,
  status: ExecutionEvent["status"],
  args: { name?: string; input?: Record<string, unknown>; output?: Record<string, unknown>; error?: string; cause?: string } = {},
): ExecutionEvent {
  const parsed = parseExecutionEvent({
    stateMachineArn: `${ARN_PREFIX}${machine}`,
    status,
    name: args.name ?? "bot-20260817T000000Z",
    input: args.input === undefined ? undefined : JSON.stringify(args.input),
    output: args.output === undefined ? undefined : JSON.stringify(args.output),
    error: args.error,
    cause: args.cause,
  });
  assert.ok(parsed, "fixture event must parse");
  return parsed;
}

test("a start is announced with its requester, and ready with the address", () => {
  const requested = renderNotification(
    event("spawnpoint-start-server", "RUNNING", { input: { requestedBy: "telegram:111" } }),
  );
  assert.match(requested ?? "", /telegram:111 requested/);

  const ready = renderNotification(
    event("spawnpoint-start-server", "SUCCEEDED", { output: { connectionAddress: "172.29.23.24:25565" } }),
  );
  assert.match(ready ?? "", /172\.29\.23\.24:25565/);

  const failed = renderNotification(event("spawnpoint-start-server", "FAILED"));
  assert.match(failed ?? "", /Start failed/);
});

test("the watchdog announces only the stops that mean something", () => {
  assert.equal(renderNotification(event("spawnpoint-idle-watchdog", "RUNNING")), null);
  assert.match(
    renderNotification(event("spawnpoint-idle-watchdog", "SUCCEEDED", { output: { status: "stopped_idle" } })) ?? "",
    /Nobody online/,
  );
  assert.match(
    renderNotification(
      event("spawnpoint-idle-watchdog", "SUCCEEDED", { output: { status: "stopped_session_cap" } }),
    ) ?? "",
    /Session cap/,
  );
  assert.equal(
    renderNotification(
      event("spawnpoint-idle-watchdog", "SUCCEEDED", { output: { status: "host_stopped_externally" } }),
    ),
    null,
    "an externally stopped host was announced by whoever stopped it",
  );
  assert.match(renderNotification(event("spawnpoint-idle-watchdog", "FAILED")) ?? "", /running-hours alarm/);
});

test("child executions stay silent, so nothing is announced twice", () => {
  for (const name of [
    "bot-20260817T000000Z-idle-3",
    "bot-20260817T000000Z-cap-96",
    "promote-1-stop",
    "promote-1-restop",
    "promote-1-rollback",
    "promote-1-rollback-stop",
    "promote-1-start",
  ]) {
    assert.equal(renderNotification(event("spawnpoint-start-server", "RUNNING", { name })), null, name);
    assert.equal(renderNotification(event("spawnpoint-promote-release", "RUNNING", { name })), null, name);
  }
  // Stop successes are silent even at top level — the orderer announces.
  assert.equal(renderNotification(event("spawnpoint-stop-server", "SUCCEEDED", { name: "manual-1" })), null);
});

test("a failed stop always speaks, child or not — it is the backup contract failing", () => {
  for (const name of ["manual-1", "bot-20260817T000000Z-idle-3", "promote-1-restop"]) {
    assert.match(renderNotification(event("spawnpoint-stop-server", "FAILED", { name })) ?? "", /backup/);
  }
});

test("an unknown host after a verified backup does not claim the world may be unsaved", () => {
  const message = renderNotification(event("spawnpoint-stop-server", "FAILED", {
    name: "manual-stop-1",
    error: "Spawnpoint.HostActivityUnknown",
    cause: "The session stopped and its world is backed up, but host activity was unreadable.",
  })) ?? "";
  assert.match(message, /world was saved and its backup verified/);
  assert.match(message, /EC2 may still be running/);
  assert.doesNotMatch(message, /may be unsaved/);
});

test("a failed Fleet drain pages the owner with the host id", () => {
  assert.equal(renderNotification(event("spawnpoint-drain-host-v2", "SUCCEEDED", { input: { hostId: "i-test" } })), null);
  assert.match(renderNotification(event("spawnpoint-drain-host-v2", "FAILED", { input: { hostId: "i-test" } })) ?? "", /i-test.*still be billed/);
});

test("promotion narrates its whole arc", () => {
  const input = { release: "1.1" };
  assert.match(
    renderNotification(event("spawnpoint-promote-release", "RUNNING", { input })) ?? "",
    /1\.1 is being promoted/,
  );
  assert.match(
    renderNotification(
      event("spawnpoint-promote-release", "SUCCEEDED", { input, output: { status: "promoted", server: "running" } }),
    ) ?? "",
    /1\.1 is live and the server is up/,
  );
  assert.match(
    renderNotification(
      event("spawnpoint-promote-release", "SUCCEEDED", {
        input,
        output: { status: "rolled_back", active_release: "1.0" },
      }),
    ) ?? "",
    /rolled back to 1\.0/,
  );
  assert.equal(
    renderNotification(
      event("spawnpoint-promote-release", "SUCCEEDED", { input, output: { status: "already_active" } }),
    ),
    null,
  );
  assert.match(
    renderNotification(event("spawnpoint-promote-release", "FAILED", { input })) ?? "",
    /pointer tells the truth/,
  );
});

test("the Lifecycle V2 machines EventBridge routes are announced like their V1 names", () => {
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "RUNNING", { input: { requestedBy: "panel:owner", serverId: "factorio" } })) ?? "", /panel:owner requested/);
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "SUCCEEDED", { output: { status: "ready", connectionAddress: "factorio-base.spawnpoint.example:34197" } })) ?? "", /factorio-base\.spawnpoint\.example:34197/);
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "FAILED", { error: "Spawnpoint.SessionUnplaced" })) ?? "", /Start failed/);
  assert.match(renderNotification(event("spawnpoint-idle-watchdog-v2", "SUCCEEDED", { name: "panel-start-1-watchdog", output: { status: "stopped_idle" } })) ?? "", /Nobody online/);
  assert.equal(renderNotification(event("spawnpoint-idle-watchdog-v2", "SUCCEEDED", { output: { status: "session_superseded" } })), null);
  assert.match(renderNotification(event("spawnpoint-stop-server-v2", "FAILED", { name: "panel-stop-1", error: "Spawnpoint.V2VerifiedStopFailed" })) ?? "", /backup/);
  assert.equal(renderNotification(event("spawnpoint-stop-server-v2", "SUCCEEDED", { name: "panel-stop-1" })), null);
  for (const name of ["panel-start-1-target-start", "panel-start-1-rollback-start"]) {
    assert.equal(renderNotification(event("spawnpoint-start-server-v2", "RUNNING", { name })), null, name);
  }
});

test("with two worlds of one game running, each message names its world", () => {
  const input = { serverId: "world#minecraft-rostik-1a2b3c4d", gameId: "minecraft", worldId: "minecraft-rostik-1a2b3c4d", worldName: "Rostik", requestedBy: "identity:1" };
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "RUNNING", { input })) ?? "", /identity:1 requested Rostik\./);
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "SUCCEEDED", { input, output: { connectionAddress: "minecraft-rostik-1a2b3c4d.spawnpoint.example:25565" } })) ?? "", /^\[READY\] Rostik is up: /);
  assert.match(renderNotification(event("spawnpoint-start-server-v2", "FAILED", { input })) ?? "", /Start of Rostik failed/);
  assert.match(renderNotification(event("spawnpoint-idle-watchdog-v2", "SUCCEEDED", { input, output: { status: "stopped_idle" } })) ?? "", /^\[STOPPED\] Rostik: nobody online/);
  assert.equal(notificationSubscriptionKey(event("spawnpoint-start-server-v2", "SUCCEEDED", { input })), "minecraft.started", "a world's own record is not a game");
  assert.equal(notificationSubscriptionKey(event("spawnpoint-start-server-v2", "SUCCEEDED", { input: { ...input, gameId: undefined } })), "minecraft.started", "a key that is not a game falls back to the legacy rule");
});

test("a stop a player cancelled, or one for a session already gone, is not a failed backup", () => {
  assert.match(renderNotification(event("spawnpoint-stop-server-v2", "FAILED", { name: "panel-stop-1", error: "Spawnpoint.V2StopRefusedPlayersOnline" })) ?? "", /Players are online.*Nothing was lost/);
  assert.equal(renderNotification(event("spawnpoint-stop-server-v2", "FAILED", { name: "panel-start-1-watchdog-idle-3", error: "Spawnpoint.V2StopRefusedPlayersOnline" })), null, "the watchdog tries again");
  assert.equal(renderNotification(event("spawnpoint-stop-server-v2", "FAILED", { name: "panel-stop-2", error: "Spawnpoint.V2StaleSession" })), null);
});

test("unknown machines and malformed details are silence, not crashes", () => {
  assert.equal(renderNotification(event("spawnpoint-something-new", "SUCCEEDED")), null);
  assert.equal(parseExecutionEvent(null), null);
  assert.equal(parseExecutionEvent({ status: "SUCCEEDED" }), null);
  const withBadJson = parseExecutionEvent({
    stateMachineArn: `${ARN_PREFIX}spawnpoint-start-server`,
    status: "SUCCEEDED",
    name: "x",
    input: "{not json",
  });
  assert.ok(withBadJson);
  assert.equal(withBadJson.input, null);
});

test("ordinary lifecycle messages map to per-game subscriptions", () => {
  assert.equal(notificationSubscriptionKey(event("spawnpoint-start-server", "RUNNING")), "minecraft.started");
  assert.equal(
    notificationSubscriptionKey(event("spawnpoint-start-server", "SUCCEEDED", { input: { gameId: "factorio", worldId: "factorio" } })),
    "factorio.started",
  );
  assert.equal(
    notificationSubscriptionKey(event("spawnpoint-idle-watchdog", "SUCCEEDED", { input: { worldId: "factorio" }, output: { status: "stopped_idle" } })),
    "factorio.stopped",
  );
  assert.equal(notificationSubscriptionKey(event("spawnpoint-start-server", "FAILED")), null, "failures remain operational alerts");
  assert.equal(notificationSubscriptionKey(event("spawnpoint-start-server-v2", "SUCCEEDED", { input: { serverId: "zomboid", worldId: "zomboid-muldraugh-1a2b3c4d" } })), "zomboid.started", "a V2 input names its game as the server id");
  assert.equal(notificationSubscriptionKey(event("spawnpoint-idle-watchdog-v2", "SUCCEEDED", { input: { serverId: "factorio", worldId: "factorio-base-1a2b3c4d" }, output: { status: "stopped_idle" } })), "factorio.stopped");
  assert.equal(notificationSubscriptionKey(event("spawnpoint-promote-release", "SUCCEEDED")), null, "release messages are not personal lifecycle subscriptions");
});
