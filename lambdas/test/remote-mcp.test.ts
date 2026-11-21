import assert from "node:assert/strict";
import test from "node:test";

process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";
process.env.API_URL = "https://api.spawnpoint.example";
process.env.PANEL_URL = "https://spawnpoint.example";

const { handler } = await import("../src/handlers/access-api.ts");

test("OAuth discovery binds authorization to the exact MCP resource", async () => {
  const server = await handler({ routeKey: "GET /.well-known/oauth-authorization-server" });
  const serverBody = JSON.parse(server.body) as Record<string, unknown>;
  assert.equal(serverBody.issuer, "https://api.spawnpoint.example");
  assert.equal(serverBody.authorization_endpoint, "https://api.spawnpoint.example/oauth/authorize");
  assert.equal(serverBody.token_endpoint, "https://api.spawnpoint.example/oauth/token");
  assert.equal(serverBody.registration_endpoint, "https://api.spawnpoint.example/oauth/register");
  assert.deepEqual(serverBody.code_challenge_methods_supported, ["S256"]);

  const resource = await handler({ routeKey: "GET /.well-known/oauth-protected-resource/mcp" });
  assert.deepEqual(JSON.parse(resource.body), {
    resource: "https://api.spawnpoint.example/mcp",
    authorization_servers: ["https://api.spawnpoint.example"],
    scopes_supported: ["spawnpoint.read", "spawnpoint.operate"],
  });
});

test("the MCP resource challenges an unauthenticated client with its metadata URL", async () => {
  const result = await handler({ routeKey: "POST /mcp", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers["www-authenticate"], 'Bearer resource_metadata="https://api.spawnpoint.example/.well-known/oauth-protected-resource/mcp"');
});

test("an OAuth access token of a deleted identity is refused", async (t) => {
  const { accessTable } = await import("./access-table.ts");
  const { document, ssm } = await import("../src/handlers/api/clients.ts");
  const { issueOAuthAccessToken } = await import("../src/access/oauth.ts");
  const secret = "test-secret-that-is-long-enough";
  t.mock.method(ssm, "send", async () => ({ Parameter: { Value: secret } }));
  const identityId = "00000000-0000-4000-8000-0000000000b1";
  const token = issueOAuthAccessToken({
    identityId, clientId: "client-1", audience: "https://api.spawnpoint.example/mcp", scopes: ["spawnpoint.read"],
  }, "https://api.spawnpoint.example", secret);
  const request = {
    routeKey: "POST /mcp", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  };
  const { table } = accessTable(t, document, [
    { pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: "Agent owner", role_id: "operator", direct_grants: [], status: "ACTIVE" },
  ]);
  assert.equal((await handler(request)).statusCode, 200);
  table.clear();
  assert.equal((await handler(request)).statusCode, 401);
});
