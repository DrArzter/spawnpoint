import assert from "node:assert/strict";
import test from "node:test";

process.env.OPERATION_STATE_MACHINES ??= JSON.stringify(["start", "stop", "promote", "world"].map((type) => ({ type, arn: `arn:aws:states:eu-central-1:123456789012:stateMachine:${type}` })));
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
process.env.SESSION_SIGNING_SECRET_PARAMETER ??= "/spawnpoint/auth/session-signing-secret";
process.env.CONTROL_PLANE_VIEW_TABLE ??= "spawnpoint-control-plane-view-test";
process.env.CONTROL_PLANE_WEBSOCKET_URL ??= "wss://socket.example.test/live";

const { cachedFeatureFlags, parseFeatureFlags, NO_FLAGS } = await import("../src/handlers/api/feature-flags.ts");
const { CAPABILITY_NAMES, switchedOffRoutes } = await import("../src/handlers/api/capabilities.ts");
const { apiDeployment } = await import("../src/handlers/api/route-table.ts");
const { createDispatcher } = await import("../src/handlers/api/dispatcher.ts");
const { mcpTools } = await import("../src/handlers/api/mcp.ts");
const { runTool } = await import("../src/handlers/api/tool-catalogue.ts");
import type { FeatureFlags, FeatureFlagValues } from "../src/handlers/api/feature-flags.ts";
import type { Identity } from "../src/access/domain.ts";

// Feature flags kept in SSM (ADR-0107): parsed with care, cached a minute,
// failing open, and switching a capability off in the session and at the gate.

type Logged = { warnings: string[]; errors: string[]; warn: (message: string) => void; error: (message: string) => void };
function log(): Logged {
  const logged: Logged = { warnings: [], errors: [], warn: (message) => { logged.warnings.push(message); }, error: (message) => { logged.errors.push(message); } };
  return logged;
}

const owner: Identity = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] };
const flags = (values: FeatureFlagValues): FeatureFlags => ({ read: async () => values });

test("flags parse: off names capabilities, skins names skins, both optional", () => {
  const logged = log();
  const parsed = parseFeatureFlags('{"off": ["worldLog", "assistant"], "skins": ["console"]}', CAPABILITY_NAMES, logged);
  assert.deepEqual([...parsed!.off], ["worldLog", "assistant"]);
  assert.deepEqual(parsed!.skins, ["console"]);
  assert.deepEqual(logged.warnings, []);
  const empty = parseFeatureFlags("{}", CAPABILITY_NAMES, logged);
  assert.deepEqual([...empty!.off], []);
  assert.equal(empty!.skins, null);
});

test("flags parse: an unknown capability or key is left out with one warning", () => {
  const logged = log();
  const parsed = parseFeatureFlags('{"off": ["worldLog", "teleport"], "colour": "red"}', CAPABILITY_NAMES, logged);
  assert.deepEqual([...parsed!.off], ["worldLog"]);
  assert.equal(logged.warnings.length, 1);
  assert.match(logged.warnings[0]!, /key colour, capability teleport/);
});

test("flags parse: a value that is not flags is refused", () => {
  for (const text of ["not json", "[]", "null", '"off"', '{"off": "worldLog"}', '{"off": [1]}', '{"skins": "console"}', '{"skins": [""]}']) {
    assert.equal(parseFeatureFlags(text, CAPABILITY_NAMES, log()), null, text);
  }
});

test("flags cache: one read serves a minute, then the parameter is read again", async () => {
  let clock = 0;
  let reads = 0;
  let stored = '{"off": ["worldLog"]}';
  const cached = cachedFeatureFlags(async () => { reads += 1; return stored; }, { capabilities: CAPABILITY_NAMES, now: () => clock, log: log() });
  assert.deepEqual([...(await cached.read()).off], ["worldLog"]);
  stored = '{"off": ["backups"]}';
  clock = 59_999;
  await Promise.all([cached.read(), cached.read()]);
  assert.equal(reads, 1, "within the minute nothing is read");
  clock = 60_000;
  const [first, second] = await Promise.all([cached.read(), cached.read()]);
  assert.equal(reads, 2, "two requests at expiry share one read");
  assert.deepEqual([...first.off], ["backups"]);
  assert.equal(first, second);
});

test("flags cache: a bad value or a failed read keeps the last good value, and before one everything is on", async () => {
  let clock = 0;
  const logged = log();
  let stored: string | Error = "{not json";
  const cached = cachedFeatureFlags(async () => { if (stored instanceof Error) throw stored; return stored; }, { capabilities: CAPABILITY_NAMES, now: () => clock, log: logged });
  assert.equal(await cached.read(), NO_FLAGS, "no good value yet: everything on");
  assert.match(logged.errors[0]!, /not valid flags JSON; everything stays on/);
  clock += 60_000;
  stored = '{"off": ["worldLog"]}';
  assert.deepEqual([...(await cached.read()).off], ["worldLog"]);
  clock += 60_000;
  stored = '{"off": "worldLog"';
  assert.deepEqual([...(await cached.read()).off], ["worldLog"], "a bad value keeps the last good one");
  assert.match(logged.errors[1]!, /the last good value stays/);
  clock += 60_000;
  stored = new Error("AccessDenied");
  assert.deepEqual([...(await cached.read()).off], ["worldLog"], "a failed read keeps it too");
  assert.match(logged.errors[2]!, /could not be read/);
});

test("a capability with its own route group is refused whole; another loses its named route", () => {
  const groups = { worldLog: { "POST /games/{gameId}/worlds/{worldId}/log": {}, "GET /games/{gameId}/worlds/{worldId}/log/{readId}": {} } };
  assert.deepEqual([...switchedOffRoutes(new Set(["worldLog", "backups"]), groups)].sort(), [
    "GET /games/{gameId}/worlds/{worldId}/backups",
    "GET /games/{gameId}/worlds/{worldId}/log/{readId}",
    "POST /games/{gameId}/worlds/{worldId}/log",
  ]);
  assert.deepEqual([...switchedOffRoutes(new Set(["teleport"]))], []);
});

test("off hides a capability from the session and the deployment refuses its routes", async () => {
  const all = apiDeployment(flags(NO_FLAGS));
  const off = apiDeployment(flags({ off: new Set(["worldLog", "backups"]), skins: ["console"] }));
  assert.ok((await all.capabilities()).includes("worldLog"));
  const capabilities = await off.capabilities();
  assert.ok(!capabilities.includes("worldLog") && !capabilities.includes("backups"));
  assert.ok(capabilities.includes("worldMetrics"), "the rest stays on");
  const refused = await off.switchedOff();
  assert.ok(refused.has("POST /games/{gameId}/worlds/{worldId}/log") && refused.has("GET /games/{gameId}/worlds/{worldId}/log/{readId}"), "the world log's group");
  assert.ok(refused.has("GET /games/{gameId}/worlds/{worldId}/backups"));
  assert.ok(!refused.has("POST /games/{gameId}/worlds/{worldId}/backups/download"), "backups has no group of its own: only its named route");
  assert.equal((await all.switchedOff()).size, 0);
});

test("the dispatcher answers a switched-off route 404 feature_off, after the caller's authority", async () => {
  const off = apiDeployment(flags({ off: new Set(["worldLog"]), skins: null }));
  const handler = createDispatcher(off.routes, {
    caller: async () => ({ provider: "telegram", subject: "1", displayName: "Owner", username: null, email: null, photoUrl: null }),
    resolveIdentity: async () => owner,
    panelOrigins: [],
    switchedOff: off.switchedOff,
  });
  const result = await handler({ routeKey: "POST /games/{gameId}/worlds/{worldId}/log", pathParameters: { gameId: "minecraft", worldId: "w" }, headers: {} });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(JSON.parse(result.body as string), { error: "feature_off" });
  const anonymous = createDispatcher(off.routes, { caller: async () => null, resolveIdentity: async () => null, panelOrigins: [], switchedOff: off.switchedOff });
  assert.equal((await anonymous({ routeKey: "POST /games/{gameId}/worlds/{worldId}/log", headers: {} })).statusCode, 401, "a stranger learns nothing about the flags");
});

test("an agent neither sees nor runs a switched-off tool", async () => {
  const off = apiDeployment(flags({ off: new Set(["backups"]), skins: null }));
  const { tools, routes, switchedOff } = off.tools();
  const refused = await switchedOff();
  const backups = tools.find((tool) => tool.routeKey === "GET /games/{gameId}/worlds/{worldId}/backups");
  assert.ok(backups, "the backups list is a tool");
  assert.ok(mcpTools(off.tools()).some((tool) => tool.name === backups.facts.name));
  assert.ok(!mcpTools(off.tools(), refused).some((tool) => tool.name === backups.facts.name), "MCP does not list it");
  const result = await runTool(routes, backups, owner, { gameId: "minecraft", worldId: "w" }, undefined, refused);
  assert.equal(result?.statusCode, 404);
  assert.deepEqual(JSON.parse(result!.body as string), { error: "feature_off" });
});

test("the SSM adapter reads the named parameter, and without a name everything is on", async () => {
  const { ssmFeatureFlags } = await import("../src/handlers/api/ssm-feature-flags.ts");
  const { ALL_ON } = await import("../src/handlers/api/feature-flags.ts");
  const asked: unknown[] = [];
  const client = { send: async (command: { input: unknown }) => { asked.push(command.input); return { Parameter: { Value: '{"off": ["worldLog"]}' } }; } };
  const read = ssmFeatureFlags(client as never, CAPABILITY_NAMES, "/spawnpoint/flags");
  assert.deepEqual([...(await read.read()).off], ["worldLog"]);
  assert.deepEqual(asked, [{ Name: "/spawnpoint/flags" }]);
  assert.equal(ssmFeatureFlags(client as never, CAPABILITY_NAMES, ""), ALL_ON);
});
