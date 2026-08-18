import assert from "node:assert/strict";
import test from "node:test";

import { parseExecutionEvent, renderNotification, type ExecutionEvent } from "../src/domain/notifications.ts";

const ARN_PREFIX = "arn:aws:states:eu-central-1:123456789012:stateMachine:";

function event(
  machine: string,
  status: ExecutionEvent["status"],
  args: { name?: string; input?: Record<string, unknown>; output?: Record<string, unknown> } = {},
): ExecutionEvent {
  const parsed = parseExecutionEvent({
    stateMachineArn: `${ARN_PREFIX}${machine}`,
    status,
    name: args.name ?? "bot-20260817T000000Z",
    input: args.input === undefined ? undefined : JSON.stringify(args.input),
    output: args.output === undefined ? undefined : JSON.stringify(args.output),
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
