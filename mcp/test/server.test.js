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
    "get_backup_download_link",
    "get_control_plane",
    "get_host_metrics",
    "get_profile",
    "get_release",
    "get_release_mod_link",
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

test("download tools ask the API for a link: a mod by its digest, a backup by its key", async () => {
  const calls = [];
  const api = { request: async (path, init) => {
    calls.push({ path, init });
    return { url: "https://example.invalid/link" };
  } };
  const server = createServer(api);
  const client = new Client({ name: "spawnpoint-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const sha256 = "a".repeat(64);
  await client.callTool({ name: "get_release", arguments: { gameId: "minecraft", presetId: "industrial", version: "1.2" } });
  await client.callTool({ name: "get_release_mod_link", arguments: { gameId: "minecraft", presetId: "industrial", version: "1.2", sha256 } });
  await client.callTool({ name: "get_backup_download_link", arguments: { gameId: "minecraft", worldId: "minecraft-rostik-12345678", key: "worlds/minecraft-rostik-12345678/archives/a.tar.zst" } });
  assert.deepEqual(calls, [
    { path: "/games/minecraft/presets/industrial/releases/1.2", init: undefined },
    { path: `/games/minecraft/presets/industrial/releases/1.2/mods/${sha256}`, init: undefined },
    {
      path: "/games/minecraft/worlds/minecraft-rostik-12345678/backups/download",
      init: { method: "POST", body: JSON.stringify({ key: "worlds/minecraft-rostik-12345678/archives/a.tar.zst" }) },
    },
  ]);

  // A digest that is not one never reaches the API.
  const refused = await client.callTool({ name: "get_release_mod_link", arguments: { gameId: "minecraft", presetId: "industrial", version: "1.2", sha256: "../../x" } });
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 3);

  await client.close();
  await server.close();
});
