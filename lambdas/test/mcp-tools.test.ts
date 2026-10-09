import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mcpTools } from "../src/access/mcp-tools.ts";

test("the remote MCP endpoint and the local adapter offer the same tools", async () => {
  const adapter = await readFile(new URL("../../mcp/src/server.ts", import.meta.url), "utf8");
  const local = [...adapter.matchAll(/registerTool\("([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(mcpTools.map((tool) => tool.name).sort(), local);
});

test("download tools keep the permissions their web routes have (ADR-0065)", () => {
  const byName = new Map(mcpTools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("get_release")?.permission, "release.read");
  assert.equal(byName.get("get_release_mod_link")?.permission, "release.read");
  // A whole save is its own trust, apart from listing which backups exist.
  assert.equal(byName.get("get_backup_download_link")?.permission, "backup.download");
  assert.equal(byName.get("list_world_backups")?.permission, "backup.read");
  for (const name of ["get_release", "get_release_mod_link", "get_backup_download_link"] as const) {
    assert.equal(byName.get(name)?.scope, "spawnpoint.read");
    assert.equal(byName.get(name)?.readOnly, true);
  }
  assert.deepEqual(byName.get("get_backup_download_link")?.inputSchema.required, ["gameId", "worldId", "key"]);
  assert.deepEqual(byName.get("get_release_mod_link")?.inputSchema.required, ["gameId", "presetId", "version", "sha256"]);
});
