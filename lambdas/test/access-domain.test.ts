import assert from "node:assert/strict";
import test from "node:test";

import {
  builtInRoles,
  can,
  permissionsOf,
  roleOf,
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
  assert.deepEqual([...permissionsOf(identity)].sort(), ["metrics.read", "status.read"]);
  assert.equal(can(identity, "metrics.read"), true);
  assert.equal(can(identity, "session.start"), false);
});

test("an unknown role grants nothing of its own, and its direct grants still apply", () => {
  const identity = { id: "i-2", displayName: "Bo", roleId: "retired-role", directGrants: ["metrics.read"] as const };
  assert.equal(roleOf(identity), null);
  assert.deepEqual([...permissionsOf(identity)], ["metrics.read"]);
  assert.equal(can(identity, "status.read"), false);
});

test("a reserved permission or an unknown id stored as a direct grant grants nothing", () => {
  const identity = { id: "i-3", displayName: "Cy", roleId: "operator", directGrants: ["access.owner.grant", "made.up"] as never[] };
  assert.equal(can(identity, "access.owner.grant"), false);
  assert.equal([...permissionsOf(identity)].includes("made.up" as never), false);
  assert.equal(can({ ...identity, roleId: "owner" }, "access.owner.grant"), true);
});
