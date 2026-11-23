import assert from "node:assert/strict";
import test from "node:test";

import { builtInRoles, reservedPermissions } from "../src/access/domain.ts";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { approve } = await import("../src/handlers/api/access.ts");

const owner = { id: "owner", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

test("a direct grant cannot carry a permission held only through the Owner role", async () => {
  for (const permission of reservedPermissions) {
    const refused = await approve(owner, "telegram", "42", JSON.stringify({ roleId: "viewer", directGrants: [permission] }));
    assert.equal(refused.statusCode, 400);
    assert.deepEqual(JSON.parse(refused.body), { error: "reserved_permission" });
  }
});

test("every reserved permission is the Owner role's, so the last-owner rule counts its holders", () => {
  assert.ok(reservedPermissions.includes("access.owner.grant"));
  for (const permission of reservedPermissions) {
    const holders = Object.values(builtInRoles).filter((role) => role.permissions.includes(permission)).map((role) => role.id);
    assert.deepEqual(holders, ["owner"]);
  }
});
