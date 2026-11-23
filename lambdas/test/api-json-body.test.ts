import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { type Identity } from "../src/access/domain.ts";
import { createDispatcher } from "../src/handlers/api/dispatcher.ts";
import { type Caller, type Event, parseJsonObject } from "../src/handlers/api/http.ts";

// The route table reads its configuration when it loads, so it is imported
// after a fixture environment exists. Nothing here calls AWS.
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";
// Switch on the optional login routes so they reach their body parser.
process.env.GOOGLE_OIDC_CLIENT_ID ??= "google-client.example.test";
process.env.PASSWORD_LOGIN_ENABLED ??= "true";
process.env.PASSWORD_REGISTRATION_ENABLED ??= "true";
process.env.EMAIL_DELIVERY_PROVIDER ??= "resend";
const { routes } = await import("../src/handlers/access-api.ts");

const principal: Caller = { provider: "telegram", subject: "123", displayName: "Test", username: null, email: null, photoUrl: null };
const owner: Identity = { id: "owner", displayName: "Test", roleId: "owner", directGrants: [] };
const handler = createDispatcher(routes, {
  caller: async () => principal,
  resolveIdentity: async () => owner,
  panelOrigins: ["https://panel.example"],
});

// Routes that read a JSON object body. A body that is not one object is a 400
// before the handler does anything else.
const READS_BODY = [
  "POST /access/candidates/{platform}/{platformUserId}/approve",
  "POST /access/identities/{identityId}/role",
  "POST /access/roles",
  "POST /access/roles/{roleId}",
  "POST /access/roles/{roleId}/delete",
  "POST /access/defaults",
  "POST /access/invitations",
  "POST /access/invitations/proof",
  "POST /access/invitations/redeem",
  "POST /auth/access-invitations/check",
  "POST /auth/email/verification",
  "POST /auth/email/verification/resend",
  "POST /auth/google",
  "POST /auth/password",
  "POST /auth/password/forgot",
  "POST /auth/password/register",
  "POST /auth/password/reset",
  "POST /auth/telegram",
  "POST /games/{gameId}/presets/{presetId}/builds",
  "POST /games/{gameId}/presets/{presetId}/releases/{version}/retire",
  "POST /games/{gameId}/presets/{presetId}/worlds",
  "POST /games/{gameId}/worlds/{worldId}/archive",
  "POST /games/{gameId}/worlds/{worldId}/backups/download",
  "POST /games/{gameId}/worlds/{worldId}/console",
  "POST /games/{gameId}/worlds/{worldId}/invitations",
  "POST /games/{gameId}/worlds/{worldId}/promote",
  "POST /games/{gameId}/worlds/{worldId}/purge",
  "POST /games/{gameId}/worlds/{worldId}/restore",
  "POST /games/{gameId}/worlds/{worldId}/stop",
  "POST /games/{gameId}/worlds/{worldId}/wipe",
  "POST /me/accounts/{provider}",
  "POST /me/password",
  "POST /me/password/change",
  "POST /me/avatar",
  "PUT /games/{gameId}/worlds/{worldId}/game-settings",
  "PUT /games/{gameId}/worlds/{worldId}/settings",
  "PUT /games/{gameId}/worlds/{worldId}/whitelist",
  "PUT /me/appearance",
  "PUT /me/subscriptions",
];

// Writes that do not read a body, or that answer in a protocol's own error format.
const OTHER_WRITES = new Set([
  "POST /access/candidates/{platform}/{platformUserId}/dismiss",
  "POST /access/identities/{identityId}/delete",
  "POST /access/invitations/{invitationId}/revoke",
  "POST /access/request",
  "POST /auth/logout",
  "POST /me/avatar/delete",
  "POST /auth/refresh",
  "POST /control-plane/subscriptions",
  "POST /games/{gameId}/worlds/{worldId}/start",
  "POST /mcp",
  "POST /oauth/authorize",
  "POST /oauth/authorize/inspect",
  "POST /oauth/register",
  "POST /oauth/revoke",
  "POST /oauth/token",
]);

const BAD_BODIES = ["null", "[]", "1", "\"x\"", "true", "{", "not json"];

// Values that pass each handler's own path checks, so the body is the only fault.
const PARAMETERS: Record<string, string> = {
  platform: "telegram",
  platformUserId: "123456",
  identityId: "00000000-0000-4000-8000-000000000001",
  version: "1.4",
  provider: "google",
  gameId: "minecraft",
  presetId: "prominence",
  worldId: "prominence-a1b2c3d4",
};

function pathFor(routeKey: string): { rawPath: string; pathParameters: Record<string, string> } {
  const pathParameters: Record<string, string> = {};
  const rawPath = routeKey.split(" ")[1]!.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    pathParameters[name] = PARAMETERS[name] ?? "x1";
    return pathParameters[name]!;
  });
  return { rawPath, pathParameters };
}

test("every write route either reads a JSON object body or is listed as an exception", () => {
  const writes = Object.keys(routes).filter((key) => !key.startsWith("GET "));
  for (const key of writes) {
    assert.ok(READS_BODY.includes(key) || OTHER_WRITES.has(key), `${key} is a write route: add it to READS_BODY or OTHER_WRITES`);
  }
  for (const key of [...READS_BODY, ...OTHER_WRITES]) assert.ok(key in routes, `${key} is not a route`);
});

for (const routeKey of READS_BODY) {
  test(`${routeKey} answers 400 for a body that is not a JSON object`, async () => {
    for (const body of BAD_BODIES) {
      const event: Event = { routeKey, ...pathFor(routeKey), body, headers: {} };
      const result = await handler(event);
      assert.deepEqual([result.statusCode, JSON.parse(result.body)], [400, { error: "invalid_json" }], `${routeKey} with ${body}`);
    }
  });
}

test("an empty body is an empty object, and a base64 body is decoded", () => {
  assert.deepEqual(parseJsonObject({}), {});
  assert.deepEqual(parseJsonObject({ body: "" }), {});
  assert.deepEqual(parseJsonObject({ body: Buffer.from("{\"a\":1}").toString("base64"), isBase64Encoded: true }), { a: 1 });
});

test("one JSON body parser is left under handlers/api", async () => {
  const directory = new URL("../src/handlers/api/", import.meta.url);
  const parsers: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".ts")).sort()) {
    const source = await readFile(new URL(file, directory), "utf8");
    if (/\bJSON\.parse\(/.test(source)) parsers.push(file);
  }
  assert.deepEqual(parsers, ["http.ts"]);
});
