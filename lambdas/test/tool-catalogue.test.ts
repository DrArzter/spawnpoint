import "./support/api-environment.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";

const { routes, deployedTools } = await import("../src/handlers/api/route-table.ts");
const { runTool, toolCatalogue, toolEvent } = await import("../src/handlers/api/tool-catalogue.ts");
const { isToolFacts, permissionRoute } = await import("../src/handlers/api/routing.ts");
const { response } = await import("../src/handlers/api/http.ts");

// The operation catalogue (ADR-0095): every route is a tool or says why not,
// and a tool call is a request to its own route under its own authority.

const { tools } = deployedTools();

test("every route is a tool or says why it is none", () => {
  const undecided = Object.entries(routes).filter(([, route]) => route.tool === undefined).map(([key]) => key);
  assert.deepEqual(undecided, [], "declare a tool beside the route, or mark it with notATool or withoutTools");
});

test("a tool is a route that names who may run it, never a public or session route", () => {
  for (const [key, route] of Object.entries(routes)) {
    if (isToolFacts(route.tool)) assert.ok(route.access.kind === "permission" || route.access.kind === "identity", `${key} is a tool without an identity's authority`);
  }
});

test("a read changes nothing: a GET, or one of the few POSTs that only ask for something", () => {
  const readPosts = tools.filter((tool) => tool.facts.effect === "read" && tool.method !== "GET").map((tool) => tool.facts.name).sort();
  // A download link (recorded, changes no world) and a log read (asks the host, changes nothing).
  assert.deepEqual(readPosts, ["get_backup_download_link", "read_world_log"]);
  for (const tool of tools.filter((candidate) => candidate.method === "GET")) assert.equal(tool.facts.effect, "read", `${tool.facts.name} is a GET`);
});

test("the catalogue covers what a person can do by hand", () => {
  const names = new Set(tools.map((tool) => tool.facts.name));
  for (const name of ["create_world", "start_world", "stop_world", "build_release", "promote_world", "set_whitelist", "save_config_file", "send_console_command", "update_game_settings", "approve_access_request"]) {
    assert.ok(names.has(name), name);
  }
  assert.ok(tools.every((tool) => tool.facts.description.length > 20 && tool.facts.title.length > 0));
});

test("a destructive tool is a write", () => {
  for (const tool of tools.filter((candidate) => candidate.facts.destructive)) assert.equal(tool.facts.effect, "write", tool.facts.name);
});

const byName = (name: string) => tools.find((tool) => tool.facts.name === name)!;

test("a call's path arguments fill the route, and the rest is a POST's body or a GET's query", () => {
  const save = toolEvent(byName("save_config_file"), { gameId: "minecraft", worldId: "w-1", path: "config/a.toml", text: "a = 1", expectedSha256: null });
  assert.deepEqual(save?.pathParameters, { gameId: "minecraft", worldId: "w-1" });
  assert.deepEqual(JSON.parse(save?.body ?? "{}"), { path: "config/a.toml", text: "a = 1", expectedSha256: null });
  const read = toolEvent(byName("read_config_file"), { gameId: "minecraft", worldId: "w-1", path: "config/a.toml" });
  assert.deepEqual(read?.queryStringParameters, { path: "config/a.toml" });
  assert.equal(read?.body, undefined);
  assert.equal(toolEvent(byName("start_world"), { gameId: "minecraft" }), null, "a missing path argument");
  assert.equal(toolEvent(byName("start_world"), { gameId: "minecraft", worldId: "" }), null, "an empty one");
  assert.equal(toolEvent(byName("start_world"), { gameId: "minecraft", worldId: "w-1", force: true }), null, "an argument the tool does not take");
  assert.equal(toolEvent(byName("start_world"), "not an object"), null);
});

test("a tool call passes its route's own permission and reaches the handler with the identity and the agent", async () => {
  const seen: unknown[] = [];
  const table = { "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) => {
    seen.push({ identity: identity.id, path: event.pathParameters, agent: event.agent });
    return response(202, { ok: true });
  }, { name: "start_world", title: "Start", description: "Start one world, for this test of the catalogue.", effect: "write" }) };
  const [tool] = toolCatalogue(table);
  const player: Identity = { id: "p-1", displayName: "Player", roleId: "player", directGrants: [] };
  const viewer: Identity = { id: "v-1", displayName: "Viewer", roleId: "viewer", directGrants: [] };
  const agent = { clientId: "assistant", name: "Assistant" };
  assert.equal((await runTool(table, tool!, viewer, { gameId: "g", worldId: "w" }, agent))?.statusCode, 403);
  assert.deepEqual(seen, [], "a refused call never reaches the handler");
  assert.equal((await runTool(table, tool!, player, { gameId: "g", worldId: "w" }, agent))?.statusCode, 202);
  assert.deepEqual(seen, [{ identity: "p-1", path: { gameId: "g", worldId: "w" }, agent }]);
  assert.equal(await runTool(table, tool!, player, { gameId: "g" }), null);
});

test("two tools of one name, or a path parameter nobody described, are refused when the table is composed", () => {
  const facts = { name: "same", title: "Same", description: "A tool that exists twice in this test.", effect: "read" as const };
  assert.throws(() => toolCatalogue({
    "GET /a": permissionRoute("status.read", () => response(200, {}), facts),
    "GET /b": permissionRoute("status.read", () => response(200, {}), facts),
  }), /duplicate tool/);
  assert.throws(() => toolCatalogue({ "GET /things/{thingId}": permissionRoute("status.read", () => response(200, {}), facts) }), /thingId has no description/);
});
