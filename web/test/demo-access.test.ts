import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import * as store from "../src/demo/store.ts";

// The demo plays the backend for access: it serves the same shapes as
// GET /access/roles and GET /access/identities, so the UI gate and the demo
// exercise the catalogue, the default role, `assignable` and `canDelete`.

test("the demo serves the catalogue, the default role and the role flags", () => {
  const served = store.roles();
  assert.ok(served.permissions.length > 0);
  for (const entry of served.permissions) {
    assert.ok(entry.group && entry.label && entry.description, `${entry.id} has words`);
  }
  assert.ok(served.roles.some((role) => role.id === served.defaultRoleId), "the default role is one of the roles");
  assert.deepEqual(served.roles.filter((role) => role.protected).length, 1, "exactly one protected role");
  assert.equal(served.roles.find((role) => role.id === served.defaultRoleId)?.protected, false);
  for (const role of served.roles) {
    assert.equal(role.builtIn, true);
    assert.equal(role.assignable, true, "the demo caller holds the reserved permission");
    for (const permission of role.permissions) assert.ok(served.permissions.some((entry) => entry.id === permission), `${role.id} holds a catalogued permission`);
  }
});

test("the demo serves canDelete: never the caller, otherwise by the owner rules", () => {
  const identities = store.identities();
  const caller = identities.find((identity) => identity.id === "identity-owner")!;
  assert.equal(caller.canDelete, false);
  assert.ok(identities.filter((identity) => identity.id !== caller.id).every((identity) => identity.canDelete));
});

test("an approval with no role gives the default role", () => {
  const served = store.roles();
  const waiting = store.candidates()[0]!;
  const approved = store.approveCandidate(waiting.platform, waiting.platformUserId);
  assert.equal(approved.roleId, served.defaultRoleId);
  assert.equal(store.identities().find((identity) => identity.id === approved.id)?.roleId, served.defaultRoleId);
});

test("the caller can neither delete nor demote themselves", () => {
  assert.throws(() => store.deleteIdentity("identity-owner"), /yourself/);
  assert.throws(() => store.setIdentityRole("identity-owner", store.roles().defaultRoleId), /own role/);
});

test("a second holder of the protected role can be demoted and deleted while the caller keeps the role", () => {
  const protectedId = store.roles().roles.find((role) => role.protected)!.id;
  store.setIdentityRole("identity-alex", protectedId);
  assert.equal(store.identities().find((identity) => identity.id === "identity-alex")?.roleId, protectedId);
  store.setIdentityRole("identity-alex", store.roles().defaultRoleId);
  store.deleteIdentity("identity-alex");
  assert.equal(store.identities().some((identity) => identity.id === "identity-alex"), false);
});
