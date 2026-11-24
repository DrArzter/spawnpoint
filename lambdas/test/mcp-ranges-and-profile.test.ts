import "./support/api-environment.ts";

import assert from "node:assert/strict";
import test from "node:test";

const { METRIC_RANGE_NAMES } = await import("../src/control-plane/metric-ranges.ts");
const { deployedTools } = await import("../src/handlers/api/route-table.ts");
const { mcpProfile } = await import("../src/handlers/api/mcp.ts");
const { toolEvent } = await import("../src/handlers/api/tool-catalogue.ts");
const { hostMetrics } = await import("../src/handlers/api/metrics.ts");

const hostTool = deployedTools().tools.find((tool) => tool.facts.name === "get_host_metrics")!;

test("every MCP surface offers exactly the ranges the metrics API answers", async () => {
  const schema = hostTool.inputSchema as { properties?: { range?: { enum?: readonly string[] } } };
  assert.deepEqual(schema.properties?.range?.enum, METRIC_RANGE_NAMES);
  assert.equal((await hostMetrics("i-0123456789abcdef0", "1h")).statusCode, 400, "a range no surface offers is refused");
});

test("an agent's profile carries the direct grants the panel shows", () => {
  const profile = mcpProfile({ id: "id-1", displayName: "Operator", roleId: "operator", directGrants: ["release.promote"] });
  assert.equal(profile.role, "Operator");
  assert.ok(profile.permissions.includes("session.start"), "the role's permissions");
  assert.ok(profile.permissions.includes("release.promote"), "and the direct grant");
});

test("the host metrics tool names a host by hostId, and still by instanceId, its old name", () => {
  assert.deepEqual(toolEvent(hostTool, { hostId: "i-0123456789abcdef0", range: "6h" })?.pathParameters, { instanceId: "i-0123456789abcdef0" });
  assert.deepEqual(toolEvent(hostTool, { hostId: "i-0123456789abcdef0", range: "6h" })?.queryStringParameters, { range: "6h" });
  assert.deepEqual(toolEvent(hostTool, { instanceId: "i-0123456789abcdef0" })?.pathParameters, { instanceId: "i-0123456789abcdef0" });
  assert.equal(toolEvent(hostTool, { range: "6h" }), null, "a call that names no host is refused");
  assert.deepEqual((hostTool.inputSchema as { required?: unknown }).required, []);
});
