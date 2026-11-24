import assert from "node:assert/strict";
import test from "node:test";

process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.API_URL ??= "https://api.spawnpoint.example";
process.env.PANEL_URL ??= "https://spawnpoint.example";

const { METRIC_RANGE_NAMES } = await import("../src/control-plane/metric-ranges.ts");
const { mcpTools } = await import("../src/access/mcp-tools.ts");
const { mcpProfile, metricsToolArguments } = await import("../src/handlers/api/mcp.ts");
const { hostMetrics } = await import("../src/handlers/api/metrics.ts");

test("every MCP surface offers exactly the ranges the metrics API answers", async () => {
  const tool = mcpTools.find((item) => item.name === "get_host_metrics");
  const schema = tool?.inputSchema as { properties?: { range?: { enum?: readonly string[] } } } | undefined;
  assert.deepEqual(schema?.properties?.range?.enum, METRIC_RANGE_NAMES);
  assert.equal((await hostMetrics("i-0123456789abcdef0", "1h")).statusCode, 400, "a range no surface offers is refused");
});

test("an agent's profile carries the direct grants the panel shows", () => {
  const profile = mcpProfile({ id: "id-1", displayName: "Operator", roleId: "operator", directGrants: ["release.promote"] });
  assert.equal(profile.role, "Operator");
  assert.ok(profile.permissions.includes("session.start"), "the role's permissions");
  assert.ok(profile.permissions.includes("release.promote"), "and the direct grant");
});

test("the host metrics tool names a host by hostId, and still by instanceId, its old name", () => {
  assert.deepEqual(metricsToolArguments({ hostId: "i-0123456789abcdef0", range: "6h" }), ["i-0123456789abcdef0", "6h"]);
  assert.deepEqual(metricsToolArguments({ instanceId: "i-0123456789abcdef0" }), ["i-0123456789abcdef0", "24h"]);
  assert.equal(metricsToolArguments({ range: "6h" }), null, "a call that names no host is refused");
});
