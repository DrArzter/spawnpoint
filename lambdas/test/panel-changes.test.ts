import assert from "node:assert/strict";
import test from "node:test";

import { isStreamBatch, streamChanges, streamTableName } from "../src/control-plane/dynamo-stream-changes.ts";
import { PROJECTION_TARGET, panelReloads, type TableChange } from "../src/control-plane/panel-changes.ts";

const TABLES = { lifecycle: "spawnpoint-lifecycle-v2", view: "spawnpoint-control-plane-view" };
const LIFECYCLE_ARN = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2/stream/2026-11-27T12:00:00.000";
const VIEW_ARN = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-control-plane-view/stream/2026-11-27T12:00:00.000";

type Lifecycle = Readonly<Record<string, unknown>>;

const ready: Lifecycle = {
  observedState: "ready", desiredState: "running", activeSessionId: "s1", activeWorldId: "alpha",
  activeSessionAddress: "alpha.example.test", lease: null, idle: null, fencingToken: 3, updatedAtEpochSeconds: 100,
};

function lifecycleChange(serverId: string, before: Lifecycle | null, after: Lifecycle | null, at = 1_000): TableChange {
  return {
    table: TABLES.lifecycle,
    kind: before === null ? "insert" : after === null ? "remove" : "modify",
    keys: { server_id: serverId },
    oldImage: before === null ? null : { server_id: serverId, revision: 1, lifecycle: before },
    newImage: after === null ? null : { server_id: serverId, revision: 2, lifecycle: after },
    atEpochMilliseconds: at,
  };
}

function viewChange(pk: string, sk: string, at = 2_000): TableChange {
  return { table: TABLES.view, kind: "modify", keys: { pk, sk }, oldImage: null, newImage: null, atEpochMilliseconds: at };
}

test("a session record that changes what the panel shows reloads it", () => {
  for (const field of ["observedState", "desiredState", "activeSessionId", "activeWorldId", "activeSessionAddress"]) {
    const reloads = panelReloads([lifecycleChange("world#alpha", ready, { ...ready, [field]: "other" })], TABLES);
    assert.deepEqual(reloads.targets, ["world#alpha"], field);
  }
  assert.deepEqual(panelReloads([lifecycleChange("minecraft", null, ready)], TABLES).targets, ["minecraft"], "a new record");
  assert.deepEqual(panelReloads([lifecycleChange("world#alpha", ready, null)], TABLES).targets, ["world#alpha"], "a removed record");
});

test("a lease, a heartbeat or a player count reloads nothing", () => {
  const lease = { ownerOperationId: "op", fencingToken: 4, expiresAtEpochSeconds: 500 };
  const changes = [
    lifecycleChange("world#alpha", ready, { ...ready, lease, fencingToken: 4, updatedAtEpochSeconds: 101 }),
    lifecycleChange("world#alpha", ready, { ...ready, idle: { playersOnline: 2 }, updatedAtEpochSeconds: 102 }),
    lifecycleChange("world#alpha", { ...ready, activeSessionAddress: undefined }, { ...ready, activeSessionAddress: null }),
  ];
  assert.deepEqual(panelReloads(changes, TABLES), { targets: [], observedAtEpochMilliseconds: null });
});

test("lifecycle items that are not session records reload nothing", () => {
  const host: TableChange = {
    table: TABLES.lifecycle, kind: "modify", keys: { server_id: "host#i-0123" },
    oldImage: { server_id: "host#i-0123", host: { state: "ready" } }, newImage: { server_id: "host#i-0123", host: { state: "draining" } },
    atEpochMilliseconds: 1,
  };
  assert.deepEqual(panelReloads([host], TABLES).targets, []);
});

test("only the projection item of the view table reloads the panel", () => {
  const changes = [
    viewChange("SUBSCRIPTIONS#CONTROL_PLANE", "CONNECTION#abc"),
    viewChange("TICKET#hash", "CONTROL_PLANE"),
    viewChange("EVENT#2026-11-27", "id-1"),
  ];
  assert.deepEqual(panelReloads(changes, TABLES).targets, []);
  assert.deepEqual(panelReloads([viewChange("PROJECTION#CONTROL_PLANE", "DYNAMIC")], TABLES).targets, [PROJECTION_TARGET]);
});

test("one batch names each reload once and keeps the latest change time", () => {
  const reloads = panelReloads([
    lifecycleChange("world#alpha", ready, { ...ready, observedState: "stopping" }, 1_000),
    lifecycleChange("world#alpha", { ...ready, observedState: "stopping" }, { ...ready, observedState: "stopped" }, 3_000),
    viewChange("PROJECTION#CONTROL_PLANE", "DYNAMIC", 2_000),
    viewChange("PROJECTION#CONTROL_PLANE", "DYNAMIC", 2_500),
    { ...lifecycleChange("world#beta", ready, { ...ready, observedState: "moving" }, 9_000), table: "spawnpoint-access" },
  ], TABLES);
  assert.deepEqual(reloads, { targets: ["projection", "world#alpha"], observedAtEpochMilliseconds: 3_000 });
});

test("the stream adapter reads the table, the kind, the keys and the typed images", () => {
  const batch = {
    Records: [
      {
        eventName: "MODIFY",
        eventSourceARN: LIFECYCLE_ARN,
        dynamodb: {
          ApproximateCreationDateTime: 1_786_665_600.5,
          Keys: { server_id: { S: "world#alpha" } },
          OldImage: { server_id: { S: "world#alpha" }, revision: { N: "1" }, lifecycle: { M: { observedState: { S: "starting" }, lease: { NULL: true } } } },
          NewImage: { server_id: { S: "world#alpha" }, revision: { N: "2" }, lifecycle: { M: { observedState: { S: "ready" }, tags: { L: [{ S: "a" }, { BOOL: true }] }, ids: { SS: ["x"] } } } },
        },
      },
      { eventName: "REMOVE", eventSourceARN: VIEW_ARN, dynamodb: { Keys: { pk: { S: "PROJECTION#CONTROL_PLANE" }, sk: { S: "DYNAMIC" } } } },
      { eventName: "MODIFY", eventSourceARN: "arn:aws:sqs:eu-central-1:123456789012:queue", dynamodb: { Keys: { pk: { S: "x" } } } },
      { eventName: "UNKNOWN", eventSourceARN: VIEW_ARN, dynamodb: { Keys: { pk: { S: "x" } } } },
      "not a record",
    ],
  };
  assert.ok(isStreamBatch(batch));
  assert.deepEqual(streamChanges(batch), [
    {
      table: TABLES.lifecycle,
      kind: "modify",
      keys: { server_id: "world#alpha" },
      oldImage: { server_id: "world#alpha", revision: 1, lifecycle: { observedState: "starting", lease: null } },
      newImage: { server_id: "world#alpha", revision: 2, lifecycle: { observedState: "ready", tags: ["a", true] } },
      atEpochMilliseconds: 1_786_665_600_500,
    },
    { table: TABLES.view, kind: "remove", keys: { pk: "PROJECTION#CONTROL_PLANE", sk: "DYNAMIC" }, oldImage: null, newImage: null, atEpochMilliseconds: null },
  ]);
});

test("a WebSocket route is not a stream batch, and a table name comes only from a stream ARN", () => {
  assert.equal(isStreamBatch({ requestContext: { routeKey: "$connect" } }), false);
  assert.equal(isStreamBatch(null), false);
  assert.equal(streamTableName(LIFECYCLE_ARN), "spawnpoint-lifecycle-v2");
  assert.equal(streamTableName("arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"), null);
  assert.equal(streamTableName(undefined), null);
});
