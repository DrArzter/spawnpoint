import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The handler reads its configuration when the module loads, so the table is
// imported after a fixture environment exists. Nothing here calls AWS.
process.env.ACCESS_TABLE_NAME ??= "spawnpoint-access-test";
process.env.BOT_TOKEN_PARAMETER ??= "/spawnpoint/bot/token";
const { routes } = await import("../src/handlers/access-api.ts");

// Authority used to be positional: the handler resolved a session, then an
// identity, then crossed one access.manage gate, and a route inherited whatever
// it was written beneath. It read well and hid a sharp edge — a route pasted one
// line too high was authorised by nothing but a session. Now every route
// declares its own access level in one table, the dispatcher denies by default,
// and these tests keep the table honest against the deployed API.

// Routes that are deliberately reachable without a permission, with the reason
// each is safe. A route may only appear here on purpose.
const WITHOUT_PERMISSION = new Map<string, string>([
  ["POST /auth/telegram", "login itself: it is what produces a session"],
  ["GET /session", "reports the caller's own session and bootstrap state"],
  ["POST /access/request", "how somebody with no access asks for it"],
  ["GET /me", "the caller's own identity and role"],
  ["GET /me/subscriptions", "the caller's own notification choices"],
  ["PUT /me/subscriptions", "the caller's own notification choices"],
]);

async function deployedRouteKeys(): Promise<Set<string>> {
  const url = new URL("../../infra/terraform-access-api/api.tf", import.meta.url);
  const source = await readFile(url, "utf8");
  const block = source.slice(source.indexOf("access_routes = toset(["), source.indexOf("])", source.indexOf("access_routes")));
  const keys = [...block.matchAll(/"((?:GET|POST|PUT|DELETE) [^"]+)"/g)].map((match) => match[1]!);
  assert.ok(keys.length >= 15, "expected to read the deployed route list from terraform");
  return new Set(keys);
}

test("the route table and the deployed API describe the same routes", async () => {
  const deployed = await deployedRouteKeys();
  const declared = new Set(Object.keys(routes));

  for (const key of deployed) {
    assert.ok(
      declared.has(key),
      `${key} is deployed but declares no authority, so it would reach the dispatcher's default deny`,
    );
  }
  for (const key of declared) {
    assert.ok(deployed.has(key), `${key} is declared but not deployed — a dead entry, or a missing terraform route`);
  }
});

test("every route needs a permission unless it is deliberately self-scoped", () => {
  for (const [key, route] of Object.entries(routes)) {
    if (route.access.kind === "permission") {
      assert.ok(!WITHOUT_PERMISSION.has(key), `${key} both requires a permission and claims to be self-scoped`);
      continue;
    }
    assert.ok(
      WITHOUT_PERMISSION.has(key),
      `${key} is reachable with access "${route.access.kind}" and no permission. ` +
        "Give it a permission, or add it to WITHOUT_PERMISSION with the reason it needs none",
    );
  }
});

test("authority is decided by the dispatcher, never inside a route's handler", async () => {
  const url = new URL("../src/handlers/access-api.ts", import.meta.url);
  const source = await readFile(url, "utf8");
  const guards = [...source.matchAll(/requirePermission\(/g)].length;

  // The definition, the dispatcher's single call, and the two payload-dependent
  // escalations in updateRole and approve, where granting the owner role needs
  // more than the route's own permission.
  assert.equal(
    guards,
    4,
    "a handler that checks a permission itself is a second place where authority lives; " +
      "move the route-level check into the table's access level",
  );
});

test("administrative routes all sit behind access.manage", () => {
  const managed = Object.entries(routes).filter(([key]) => key.includes("/access/candidates") || key.includes("/access/identities"));
  assert.ok(managed.length >= 5, "expected the candidate and identity routes to be present");
  for (const [key, route] of managed) {
    assert.deepEqual(
      route.access,
      { kind: "permission", permission: "access.manage" },
      `${key} manages who may use Spawnpoint and must require access.manage`,
    );
  }
});
