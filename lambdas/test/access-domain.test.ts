import assert from "node:assert/strict";
import test from "node:test";

import {
  builtInRoles,
  effectivePermissions,
  hasPermission,
} from "../src/access/domain.ts";

test("visitor, player, operator and owner capabilities increase deliberately", () => {
  assert.deepEqual(builtInRoles.viewer.permissions, ["status.read"]);
  assert.equal(builtInRoles.player.permissions.includes("session.start"), true);
  assert.equal(builtInRoles.player.permissions.includes("session.stop"), false);
  assert.equal(builtInRoles.operator.permissions.includes("console.use"), true);
  assert.equal(builtInRoles.operator.permissions.includes("access.manage"), false);
  assert.equal(builtInRoles.owner.permissions.includes("access.manage"), true);
  assert.equal(builtInRoles.owner.permissions.includes("access.owner.grant"), true);
});

test("direct grants add one exception without weakening the role contract", () => {
  const identity = { id: "i-1", displayName: "Ada", roleId: "viewer", directGrants: ["metrics.read"] as const };
  assert.deepEqual([...effectivePermissions(identity, builtInRoles.viewer)].sort(), ["metrics.read", "status.read"]);
  assert.equal(hasPermission(identity, builtInRoles.viewer, "metrics.read"), true);
  assert.throws(() => effectivePermissions(identity, builtInRoles.player), /does not match/);
});
