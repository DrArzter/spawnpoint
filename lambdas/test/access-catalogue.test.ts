import assert from "node:assert/strict";
import test from "node:test";

process.env.ACCESS_TABLE_NAME ??= "access-api-test";
const { permissions, permissionCatalogue, reservedPermissions, defaultRoleId, builtInRoles } = await import("../src/access/domain.ts");
const { roles } = await import("../src/handlers/api/access.ts");

type Served = Readonly<{
  roles: readonly { id: string; builtIn: boolean; protected: boolean; version: number; assignable: boolean; description: string }[];
  permissions: readonly { id: string; group: string; label: string; description: string; reserved: boolean }[];
  defaultRoleId: string;
}>;

const served = (caller: Parameters<typeof roles>[0]) => JSON.parse(roles(caller).body as string) as Served;
const owner = { id: "o", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

test("the catalogue describes every permission once, in the code's order", () => {
  assert.deepEqual(permissionCatalogue.map((entry) => entry.id), [...permissions]);
  for (const entry of permissionCatalogue) {
    assert.ok(entry.group && entry.label && entry.description.endsWith("."), `${entry.id} needs a group, a label and a sentence`);
    assert.equal(entry.reserved, reservedPermissions.includes(entry.id));
  }
});

test("the role list carries the catalogue, the default role and the role flags", () => {
  const body = served(owner);
  assert.deepEqual(body.permissions, JSON.parse(JSON.stringify(permissionCatalogue)));
  assert.equal(body.defaultRoleId, defaultRoleId);
  assert.ok(Object.hasOwn(builtInRoles, body.defaultRoleId));
  assert.equal(body.roles.find((role) => role.id === body.defaultRoleId)?.protected, false, "the default role is never the protected one");
  assert.deepEqual(body.roles.filter((role) => role.protected).map((role) => role.id), ["owner"]);
  for (const role of body.roles) {
    assert.equal(role.builtIn, true);
    assert.equal(role.version, 1);
    assert.ok(role.description.length > 0);
  }
});

test("assignable follows the caller: only a holder of the reserved permission may give the protected role", () => {
  const assignable = (caller: Parameters<typeof roles>[0]) => Object.fromEntries(served(caller).roles.map((role) => [role.id, role.assignable]));
  assert.deepEqual(assignable(owner), { viewer: true, player: true, operator: true, owner: true });
  const manager = { id: "m", displayName: "Manager", roleId: "operator", directGrants: ["access.manage"] } as const;
  assert.deepEqual(assignable(manager), { viewer: true, player: true, operator: true, owner: false });
  const reader = { id: "r", displayName: "Reader", roleId: "viewer", directGrants: ["access.read"] } as const;
  assert.deepEqual(assignable(reader), { viewer: false, player: false, operator: false, owner: false });
});
