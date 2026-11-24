import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "grammy";

process.env.AWS_REGION ??= "eu-central-1";
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";

const { startCommand, startOutcome, startRequest } = await import("../src/bot/commands/start.ts");
const { chatCaller, chatEvent, chatRoutes, isChatRequest } = await import("../src/handlers/api/chat.ts");
const { createDispatcher } = await import("../src/handlers/api/dispatcher.ts");
const { routes } = await import("../src/handlers/api/route-table.ts");

function chat(telegramId: number | undefined) {
  const replies: string[] = [];
  const ctx = {
    from: telegramId === undefined ? undefined : { id: telegramId, is_bot: false, first_name: "Player" },
    reply: async (text: string) => { replies.push(text); },
  } as unknown as Context;
  return { ctx, replies };
}

const reply = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

test("the bot asks the API's start route for the configured world, naming the Telegram account", () => {
  const request = startRequest(111, "game-a", "world-a");
  assert.ok(isChatRequest(request));
  assert.deepEqual(request.account, { provider: "telegram", subject: "111" });
  assert.equal(request.routeKey, "POST /games/{gameId}/worlds/{worldId}/start");
  assert.deepEqual(request.pathParameters, { gameId: "game-a", worldId: "world-a" });
});

test("the API's answer becomes the bot's reply", () => {
  assert.deepEqual(startOutcome(reply(202, { result: "requested", operationId: "panel-start-1" })), { kind: "starting", operationId: "panel-start-1" });
  assert.deepEqual(startOutcome(reply(409, { error: "host_already_running" })), { kind: "busy" });
  assert.deepEqual(startOutcome(reply(409, { error: "operation_in_progress" })), { kind: "busy" });
  assert.deepEqual(startOutcome(reply(403, { error: "forbidden" })), { kind: "denied" });
  assert.deepEqual(startOutcome(reply(403, { error: "access_not_granted" })), { kind: "denied" });
  assert.deepEqual(startOutcome(reply(404, { error: "unknown_world" })), { kind: "failed" });
  assert.deepEqual(startOutcome({ statusCode: 500, body: "" }), { kind: "failed" });
});

test("a message with no sender starts nothing", async () => {
  const { ctx, replies } = chat(undefined);
  let asked = false;
  await startCommand(ctx, "reply", async () => { asked = true; return { kind: "failed" }; });
  assert.equal(asked, false);
  assert.equal(replies.length, 1);
});

test("a started session is reported with its operation", async () => {
  const { ctx, replies } = chat(111);
  await startCommand(ctx, "reply", async () => ({ kind: "starting", operationId: "panel-start-1" }));
  assert.match(replies[0] ?? "", /starting/i);
});

test("an HTTP event never reads as a chat request", () => {
  const request = startRequest(111, "game-a", "world-a");
  assert.equal(isChatRequest({ ...request, requestContext: { http: { method: "POST" } } }), false);
  assert.equal(isChatRequest({ ...request, routeKey: "DELETE /access/identities/{identityId}" }), false);
  assert.equal(isChatRequest({ ...request, account: { provider: "google", subject: "111" } }), false);
  assert.equal(isChatRequest({ ...request, account: { provider: "telegram", subject: "not-a-number" } }), false);
  assert.equal(isChatRequest({ ...request, kind: "other" }), false);
});

test("a chat runs the start route behind its declared permission", async () => {
  const request = startRequest(111, "game-a", "world-a");
  const chatOnly = chatRoutes(routes);
  assert.deepEqual(Object.keys(chatOnly), ["POST /games/{gameId}/worlds/{worldId}/start"]);
  assert.equal(chatOnly["POST /games/{gameId}/worlds/{worldId}/start"], routes["POST /games/{gameId}/worlds/{worldId}/start"]);
  const resolved: string[] = [];
  const dispatch = createDispatcher(chatOnly, {
    caller: async () => chatCaller(request),
    resolveIdentity: async (account) => {
      resolved.push(`${account.provider}:${account.subject}`);
      return { id: "identity-1", displayName: "Player", roleId: "visitor", directGrants: [] };
    },
    panelOrigins: [],
  });
  const answer = await dispatch(chatEvent(request));
  assert.deepEqual(resolved, ["telegram:111"]);
  assert.equal(answer.statusCode, 403);
  assert.equal(JSON.parse(answer.body).error, "forbidden");
});
