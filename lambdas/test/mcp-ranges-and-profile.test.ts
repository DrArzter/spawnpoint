import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { mcpProfile } = await import("../src/handlers/api/mcp.ts");
const { hostMetrics } = await import("../src/handlers/api/metrics.ts");

test("every MCP surface offers exactly the ranges the metrics API answers", async () => {
  const tool = mcpTools.find((item) => item.name === "get_host_metrics");
  const schema = tool?.inputSchema as { properties?: { range?: { enum?: readonly string[] } } } | undefined;
  assert.deepEqual(schema?.properties?.range?.enum, METRIC_RANGE_NAMES);
  const standalone = await readFile(new URL("../../mcp/src/server.ts", import.meta.url), "utf8");
  const offered = /range: z\.enum\(\[([^\]]*)\]\)/.exec(standalone)?.[1]?.split(",").map((item) => item.trim().replaceAll('"', ""));
  assert.deepEqual(offered, METRIC_RANGE_NAMES, "mcp/src/server.ts must offer the API's ranges");
  assert.equal((await hostMetrics("i-0123456789abcdef0", "1h")).statusCode, 400, "a range no surface offers is refused");
});

test("an agent's profile carries the direct grants the panel shows", () => {
  const profile = mcpProfile({ id: "id-1", displayName: "Operator", roleId: "operator", directGrants: ["release.promote"] });
  assert.equal(profile.role, "Operator");
  assert.ok(profile.permissions.includes("session.start"), "the role's permissions");
  assert.ok(profile.permissions.includes("release.promote"), "and the direct grant");
});
