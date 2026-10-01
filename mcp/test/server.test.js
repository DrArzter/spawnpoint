import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/server.js";

test("the MCP contract advertises the bounded tool set and routes calls through the API client", async () => {
  const calls = [];
  const api = { request: async (path, init) => {
    calls.push({ path, init });
    return { identity: { id: "owner-1", roleId: "owner" } };
  } };
  const server = createServer(api);
  const client = new Client({ name: "spawnpoint-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "get_control_plane",
    "get_host_metrics",
    "get_profile",
    "get_world_pack",
    "list_world_backups",
    "start_world",
    "stop_world",
  ]);
  assert.equal(tools.tools.find((tool) => tool.name === "get_profile")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find((tool) => tool.name === "start_world")?.annotations?.readOnlyHint, false);

  const profile = await client.callTool({ name: "get_profile", arguments: {} });
  assert.deepEqual(profile.structuredContent, { data: { identity: { id: "owner-1", roleId: "owner" } } });
  assert.deepEqual(calls, [{ path: "/me", init: undefined }]);

  await client.close();
  await server.close();
});
