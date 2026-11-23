import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { accessTable } from "./support/access-table.ts";

process.env.ACCESS_TABLE_NAME ??= "access-api-test";
const { permissions, permissionCatalogue, reservedPermissions, defaultRoleId, builtInRoles } = await import("../src/access/domain.ts");
const { roles } = await import("../src/handlers/api/roles.ts");
const { document } = await import("../src/handlers/api/access-store.ts");

type Served = Readonly<{
  roles: readonly { id: string; builtIn: boolean; protected: boolean; version: number; assignable: boolean; description: string; holders: number }[];
  permissions: readonly { id: string; group: string; label: string; description: string; reserved: boolean }[];
  defaultRoleId: string;
}>;

async function served(t: TestContext, caller: Parameters<typeof roles>[0]): Promise<Served> {
  t.mock.restoreAll();
  accessTable(t, document as never, [{ pk: "IDENTITY#o", sk: "PROFILE", role_id: "owner", gsi1pk: "IDENTITY#ACTIVE" }]);
  return JSON.parse((await roles(caller)).body as string) as Served;
}
const owner = { id: "o", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

test("the catalogue describes every permission once, in the code's order", () => {
  assert.deepEqual(permissionCatalogue.map((entry) => entry.id), [...permissions]);
  for (const entry of permissionCatalogue) {
    assert.ok(entry.group && entry.label && entry.description.endsWith("."), `${entry.id} needs a group, a label and a sentence`);
    assert.equal(entry.reserved, reservedPermissions.includes(entry.id));
  }
});

test("the role list carries the catalogue, the default role and the role flags", async (t) => {
  const body = await served(t, owner);
  assert.deepEqual(body.permissions, JSON.parse(JSON.stringify(permissionCatalogue)));
  assert.equal(body.defaultRoleId, defaultRoleId);
  assert.ok(Object.hasOwn(builtInRoles, body.defaultRoleId));
  assert.equal(body.roles.find((role) => role.id === body.defaultRoleId)?.protected, false, "the default role is never the protected one");
  assert.deepEqual(body.roles.filter((role) => role.protected).map((role) => role.id), ["owner"]);
  for (const role of body.roles) {
    assert.equal(role.builtIn, true);
    assert.equal(Object.hasOwn(role, "system"), false, "the old name is gone");
    assert.equal(role.version, 1);
    assert.ok(role.description.length > 0);
  }
  assert.deepEqual(Object.fromEntries(body.roles.map((role) => [role.id, role.holders])), { viewer: 0, player: 0, operator: 0, owner: 1 });
});

test("assignable follows the caller: only a caller who holds every permission of a role may give it", async (t) => {
  const assignable = async (caller: Parameters<typeof roles>[0]) => Object.fromEntries((await served(t, caller)).roles.map((role) => [role.id, role.assignable]));
  assert.deepEqual(await assignable(owner), { viewer: true, player: true, operator: true, owner: true });
  const manager = { id: "m", displayName: "Manager", roleId: "operator", directGrants: ["access.manage"] } as const;
  assert.deepEqual(await assignable(manager), { viewer: true, player: true, operator: true, owner: false });
  // No escalation: a manager who does not hold the operator's permissions cannot give that role.
  const narrow = { id: "n", displayName: "Narrow", roleId: "viewer", directGrants: ["access.manage"] } as const;
  assert.deepEqual(await assignable(narrow), { viewer: true, player: false, operator: false, owner: false });
  const reader = { id: "r", displayName: "Reader", roleId: "viewer", directGrants: ["access.read"] } as const;
  assert.deepEqual(await assignable(reader), { viewer: false, player: false, operator: false, owner: false });
});
