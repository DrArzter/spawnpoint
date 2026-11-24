import "./support/api-environment.ts";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { deployedTools } = await import("../src/handlers/api/route-table.ts");
const { mcpTools, PROFILE_TOOL } = await import("../src/handlers/api/mcp.ts");
const { localToolsJson } = await import("../src/handlers/api/tool-catalogue.ts");

const tools = mcpTools(deployedTools());
const byName = new Map(tools.map((tool) => [tool.name, tool]));

test("the local adapter's generated tool list is up to date with the catalogue", async () => {
  const committed = await readFile(new URL("../../mcp/src/tools.generated.json", import.meta.url), "utf8");
  assert.equal(committed, localToolsJson(deployedTools().tools, [PROFILE_TOOL]), "run `npm run export-mcp-tools` in lambdas/ and commit the result");
});

test("MCP offers the bounded set a feature offered it, not every tool (ADR-0095)", () => {
  assert.deepEqual([...byName.keys()].sort(), [
    "get_backup_download_link", "get_console_result", "get_control_plane", "get_host_metrics", "get_profile", "get_release",
    "get_release_mod_link", "get_world_log_result", "get_world_pack", "list_world_backups", "read_world_log",
    "send_console_command", "start_world", "stop_world",
  ]);
  assert.ok(deployedTools().tools.length > byName.size, "the assistant's catalogue is wider");
});

test("download tools keep the permissions their web routes have (ADR-0065)", () => {
  assert.equal(byName.get("get_release")?.permission, "release.read");
  assert.equal(byName.get("get_release_mod_link")?.permission, "release.read");
  // A whole save is its own trust, apart from listing which backups exist.
  assert.equal(byName.get("get_backup_download_link")?.permission, "backup.download");
  assert.equal(byName.get("list_world_backups")?.permission, "backup.read");
  for (const name of ["get_release", "get_release_mod_link", "get_backup_download_link"]) {
    assert.equal(byName.get(name)?.scope, "spawnpoint.read");
    assert.equal(byName.get(name)?.readOnly, true);
  }
  assert.deepEqual(byName.get("get_backup_download_link")?.inputSchema.required, ["gameId", "worldId", "key"]);
  assert.deepEqual(byName.get("get_release_mod_link")?.inputSchema.required, ["gameId", "presetId", "version", "sha256"]);
});

test("the console reaches an agent as the person, under the panel's permission (ADR-0063)", () => {
  const send = byName.get("send_console_command");
  const read = byName.get("get_console_result");
  assert.equal(send?.permission, "console.use");
  assert.equal(send?.scope, "spawnpoint.operate");
  // Marked as a change that may destroy, so a client asks before each call.
  assert.equal(send?.readOnly, false);
  assert.equal(send?.destructive, true);
  assert.deepEqual(send?.inputSchema.required, ["gameId", "worldId", "command"]);
  assert.equal(read?.permission, "console.use");
  assert.equal(read?.scope, "spawnpoint.read");
  assert.equal(read?.readOnly, true);
  // Every other tool MCP offers changes nothing it cannot undo.
  assert.deepEqual(tools.filter((tool) => tool.destructive).map((tool) => tool.name), ["send_console_command"]);
});
