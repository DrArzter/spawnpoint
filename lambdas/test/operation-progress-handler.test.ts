import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

process.env.OPERATION_STATE_MACHINES = JSON.stringify(["start", "stop", "promote", "world"].map((type) => ({ type, arn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${type}` })));
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";

const { awsControlPlaneSources } = await import("../src/control-plane/aws.ts");
const { operationProgress } = await import("../src/handlers/api/operations.ts");
const { operationsRoutes } = await import("../src/handlers/api/operations-routes.ts");
const { routes, deployedCapabilities } = await import("../src/handlers/api/route-table.ts");
import type { ControlPlaneSources } from "../src/control-plane/read-model.ts";
import type { OperationProgress } from "../src/control-plane/operation-progress.ts";

const progress: OperationProgress = {
  id: "panel-promote-20261122T100000-aaaa1111", type: "promote", status: "running", startedAt: "2026-11-22T10:00:00.000Z", stoppedAt: null, elapsedSeconds: 12,
  step: { key: "promote.checking_release", label: "Checking the release" }, child: null, result: null, failure: null, caught: null,
};

function reader(t: TestContext, result: OperationProgress | null) {
  const asked: unknown[] = [];
  t.mock.method(awsControlPlaneSources as Required<ControlPlaneSources>, "readOperationProgress", async (request: unknown) => {
    asked.push(request);
    return result;
  });
  return asked;
}

test("a world's operation is returned for the world in the path", async (t) => {
  const asked = reader(t, progress);
  const reply = await operationProgress("minecraft", "prominence", progress.id);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(JSON.parse(reply.body), progress);
  assert.deepEqual(asked, [{ worldId: "prominence", operationId: progress.id }]);
});

test("an unknown operation, or one of another world, is 404", async (t) => {
  reader(t, null);
  const reply = await operationProgress("minecraft", "prominence", progress.id);
  assert.equal(reply.statusCode, 404);
  assert.equal(JSON.parse(reply.body).error, "unknown_operation");
});

test("a malformed id is refused before AWS is asked", async (t) => {
  const asked = reader(t, progress);
  for (const [game, world, id] of [["minecraft", "prominence", "x/../y"], ["minecraft", "prominence", "session-1"], ["Minecraft!", "prominence", progress.id], ["minecraft", "", progress.id], ["minecraft", "prominence", `panel-${"a".repeat(90)}`]]) {
    assert.equal((await operationProgress(game!, world!, id!)).statusCode, 400, `${game}/${world}/${id}`);
  }
  assert.deepEqual(asked, []);
});

test("the route is read with the authority that reads a world's operations, and is advertised", async () => {
  const key = "GET /games/{gameId}/worlds/{worldId}/operations/{operationId}";
  assert.deepEqual(Object.keys(operationsRoutes), [key]);
  assert.deepEqual(routes[key]?.access, { kind: "permission", permission: "status.read" });
  assert.deepEqual(routes["GET /control-plane"]?.access, routes[key]?.access);
  assert.ok((await deployedCapabilities()).includes("operationProgress"));
});
