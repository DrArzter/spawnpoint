import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { accessTable } from "./support/access-table.ts";

process.env.ACCESS_TABLE_NAME ??= "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { createRoleHandler, updateRoleHandler, deleteRoleHandler, setDefaultRoleHandler } = await import("../src/handlers/api/roles.ts");
const { readDefaultRoleId, withRole } = await import("../src/handlers/api/role-store.ts");
const { can } = await import("../src/access/domain.ts");

// ADR-0083: panel roles are owner-defined data.

type Caller = Parameters<typeof createRoleHandler>[0];
const owner: Caller = { id: "owner-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const manager: Caller = { id: "manager-1", displayName: "Manager", roleId: "operator", directGrants: ["access.manage"] };
const body = (value: unknown) => JSON.stringify(value);
const status = async (pending: Promise<{ statusCode: number; body?: unknown }>) => {
  const result = await pending;
  const text = result.body === undefined || result.body === null ? "" : String(result.body);
  return [result.statusCode, text === "" || text === "null" ? null : (JSON.parse(text) as { error?: string }).error ?? "ok"];
};
const moderator = { id: "moderator", name: "Moderator", description: "Keeps the whitelist.", permissions: ["status.read", "whitelist.manage"] };
const held = (roleId: string) => ({ pk: `IDENTITY#${roleId}-holder`, sk: "PROFILE", role_id: roleId, gsi1pk: "IDENTITY#ACTIVE" });

function table(t: TestContext, seed: Parameters<typeof accessTable>[2] = []) {
  return accessTable(t, document as never, seed);
}

test("a role is created from a slug, a name and permissions the caller holds", async (t) => {
  const items = table(t);
  assert.deepEqual(await status(createRoleHandler(manager, body(moderator))), [201, "ok"]);
  assert.equal(items.get("ROLE#moderator|DEFINITION")?.version, 1);
  assert.equal(items.get("ROLE#moderator|DEFINITION")?.updated_by, "manager-1", "a change keeps who made it");
  assert.deepEqual(await status(createRoleHandler(manager, body(moderator))), [409, "role_exists"]);
  assert.deepEqual(await status(createRoleHandler(manager, body({ ...moderator, id: "operator" }))), [409, "role_exists"], "a built-in id is taken");
  assert.deepEqual(await status(createRoleHandler(manager, body({ ...moderator, id: "Bad Id" }))), [400, "invalid_role"]);
  assert.deepEqual(await status(createRoleHandler(manager, body({ ...moderator, id: "x", permissions: ["made.up"] }))), [400, "invalid_role"]);
  assert.deepEqual(await status(createRoleHandler(owner, body({ ...moderator, id: "y", permissions: ["access.owner.grant"] }))), [400, "reserved_permission"]);
  assert.deepEqual(await status(createRoleHandler(manager, body({ ...moderator, id: "z", permissions: ["release.promote"] }))), [403, "forbidden"], "no escalation");
});

test("an edit needs the current version; a built-in role's first edit writes its record", async (t) => {
  const items = table(t);
  const edit = (caller: Caller, roleId: string, version: number, permissions: string[]) =>
    status(updateRoleHandler(caller, roleId, body({ name: "Player", description: "Plays.", permissions, version })));
  assert.deepEqual(await edit(owner, "player", 1, ["status.read", "session.start"]), [200, "ok"]);
  assert.equal(items.get("ROLE#player|DEFINITION")?.version, 2);
  assert.deepEqual(await edit(owner, "player", 1, ["status.read"]), [409, "role_changed"], "an outdated version is refused");
  assert.deepEqual(await edit(owner, "owner", 1, ["status.read"]), [409, "role_protected"]);
  assert.deepEqual(await edit(owner, "nobody", 1, ["status.read"]), [404, "unknown_role"]);
  // Taking a permission away is giving it too: the caller must hold what the role loses.
  const narrow: Caller = { ...manager, roleId: "viewer" };
  assert.deepEqual(await edit(narrow, "player", 2, ["status.read"]), [403, "forbidden"]);
});

test("a role is deleted only when it is custom, unheld, not the default and unchanged", async (t) => {
  table(t, [{ pk: "ROLE#moderator", sk: "DEFINITION", role_id: "moderator", ...moderator, version: 3, gsi1pk: "ROLE" }, held("moderator")]);
  const remove = (roleId: string, version: number) => status(deleteRoleHandler(owner, roleId, body({ version })));
  assert.deepEqual(await remove("operator", 1), [409, "role_built_in"]);
  assert.deepEqual(await remove("owner", 1), [409, "role_protected"]);
  assert.deepEqual(await remove("moderator", 3), [409, "role_in_use"]);
  t.mock.restoreAll();
  table(t, [{ pk: "ROLE#moderator", sk: "DEFINITION", role_id: "moderator", ...moderator, version: 3, gsi1pk: "ROLE" }]);
  assert.deepEqual(await remove("moderator", 2), [409, "role_changed"]);
  assert.deepEqual(await status(setDefaultRoleHandler(owner, body({ defaultRoleId: "moderator" }))), [200, "ok"]);
  assert.deepEqual(await remove("moderator", 3), [409, "role_in_use"], "the default role is in use");
  assert.deepEqual(await status(setDefaultRoleHandler(owner, body({ defaultRoleId: "viewer" }))), [200, "ok"]);
  assert.deepEqual(await remove("moderator", 3), [204, null]);
});

test("the default role is stored data, never the protected role, and given only by a caller who holds it", async (t) => {
  table(t);
  assert.equal(await readDefaultRoleId(), "viewer", "Viewer until the owner chooses");
  assert.deepEqual(await status(setDefaultRoleHandler(owner, body({ defaultRoleId: "owner" }))), [409, "role_protected"]);
  assert.deepEqual(await status(setDefaultRoleHandler(owner, body({ defaultRoleId: "nobody" }))), [400, "unknown_role"]);
  assert.deepEqual(await status(setDefaultRoleHandler({ ...manager, roleId: "viewer" }, body({ defaultRoleId: "player" }))), [403, "forbidden"]);
  assert.deepEqual(await status(setDefaultRoleHandler(owner, body({ defaultRoleId: "player" }))), [200, "ok"]);
  assert.equal(await readDefaultRoleId(), "player");
});

test("an identity's permissions come from its role's record, read for the request", async (t) => {
  table(t, [
    { pk: "ROLE#moderator", sk: "DEFINITION", role_id: "moderator", ...moderator, version: 1, gsi1pk: "ROLE" },
    { pk: "ROLE#viewer", sk: "DEFINITION", role_id: "viewer", name: "Viewer", permissions: ["status.read", "metrics.read", "access.owner.grant"], version: 2, gsi1pk: "ROLE" },
    { pk: "ROLE#owner", sk: "DEFINITION", role_id: "owner", name: "Owner", permissions: [], version: 9, gsi1pk: "ROLE" },
  ]);
  const as = (roleId: string, directGrants: Caller["directGrants"] = []) => withRole({ id: "i", displayName: "I", roleId, directGrants });
  assert.equal(can(await as("moderator"), "whitelist.manage"), true);
  assert.equal(can(await as("viewer"), "metrics.read"), true, "an edited built-in role applies");
  assert.equal(can(await as("viewer"), "access.owner.grant"), false, "a stored role never grants a reserved permission");
  assert.equal(can(await as("owner"), "access.owner.grant"), true, "the protected role is always its code definition");
  const removed = await as("retired", ["session.start"]);
  assert.equal(can(removed, "status.read"), false, "a deleted role grants nothing");
  assert.equal(can(removed, "session.start"), true, "and its holder keeps the direct grants");
});
