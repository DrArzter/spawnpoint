import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { memberRemoval } from "../src/core/data.ts";
import type { AccessModel, CandidateRow, MemberRow } from "../src/core/models.ts";
import { permissionRows, protectedRoleName, roleChoice, rolePermissions } from "../src/core/roles.ts";
import { SKINS } from "../src/skins/index.ts";
import { consoleSkin } from "../src/skins/console/index.ts";
import { aMember, aPermission, aRole, noop, spy } from "./support/fixtures.ts";

/*
 * The web keeps no role ids and no owner rules. What a caller may give, what a
 * caller may delete and what a permission means all come from the API, and both
 * skins draw them. The ids below are test data; no role here is special to the code.
 */

const open = aRole({ id: "role-open", name: "Open role", permissions: ["perm.one"] });
const closed = aRole({ id: "role-closed", name: "Closed role", permissions: ["perm.one", "perm.two"], protected: true, assignable: false });
const plain = aRole({ id: "role-plain", name: "Plain role", permissions: [], builtIn: false });
const roles = [open, closed, plain];

const catalogue = [
  aPermission({ id: "perm.one", group: "Group One", label: "Do one", description: "Does the first thing." }),
  aPermission({ id: "perm.two", group: "Group Two", label: "Do two", description: "Does the second thing." }),
  aPermission({ id: "perm.idle", group: "Group Two", label: "Do nothing", description: "No role holds this one." }),
];

test("a role choice offers exactly the assignable roles", () => {
  const choice = roleChoice(roles, "role-open", false);
  assert.deepEqual(choice.options.map((option) => option.value), ["role-open", "role-plain"]);
  assert.equal(choice.value, "role-open");
  assert.equal(choice.disabled, false);
  assert.equal(roleChoice(roles, "role-open", true).disabled, true, "a change in flight locks the select");
});

test("a role the caller may not give is shown alone and locked, never offered", () => {
  const choice = roleChoice(roles, "role-closed", false);
  assert.deepEqual(choice.options, [{ value: "role-closed", label: "Closed role" }]);
  assert.equal(choice.disabled, true);
});

test("before the roles load, a choice is locked and says so", () => {
  const choice = roleChoice([], "", false);
  assert.deepEqual(choice.options, [{ value: "", label: "Loading roles…" }]);
  assert.equal(choice.disabled, true);
});

test("the protected role is found by its flag, not by its id or name", () => {
  assert.equal(protectedRoleName(roles), "Closed role");
  assert.equal(protectedRoleName([open, plain]), null);
});

test("the matrix rows are the whole catalogue in its order, then any permission only a role holds", () => {
  const stray = aRole({ id: "role-stray", permissions: ["perm.stray"] });
  assert.deepEqual(permissionRows(catalogue, [open]).map((row) => row.id), ["perm.one", "perm.two", "perm.idle"], "a permission no role holds still has its row");
  const rows = permissionRows(catalogue, [open, stray]);
  assert.deepEqual(rows.map((row) => row.id).slice(-1), ["perm.stray"]);
  assert.equal(rows.at(-1)?.label, "perm.stray");
});

test("a role's permissions read in catalogue order with the catalogue's words", () => {
  const listed = rolePermissions(catalogue, aRole({ permissions: ["perm.two", "perm.one"] }));
  assert.deepEqual(listed.map((entry) => [entry.id, entry.label]), [["perm.one", "Do one"], ["perm.two", "Do two"]]);
});

const candidate: CandidateRow = {
  id: "telegram:42",
  candidate: { platform: "telegram", platformUserId: "42", displayName: "Nikita", username: "nikita", email: null, photoUrl: null, status: "REQUESTED", firstSeenAt: "2026-09-14T18:10:00Z", lastSeenAt: "2026-09-14T18:10:00Z", requestedAt: "2026-09-14T18:10:00Z" },
  account: "@nikita",
  since: "Requested access Sep 14",
  role: roleChoice(roles, "role-open", false),
  setRoleId: noop,
  approve: spy("access.approve", "Approve"),
  dismiss: spy("access.dismiss", "Dismiss"),
};

function row(over: { id: string; name: string; roleId: string; canDelete: boolean }): MemberRow {
  const member = aMember(over);
  return { member, role: roleChoice(roles, member.roleId, false), setRoleId: noop, changing: false, linkedAccounts: spy("access.linked", "Linked accounts"), remove: memberRemoval(member, () => undefined) };
}

const model: AccessModel = {
  tab: "users",
  setTab: noop,
  roleCount: roles.length,
  catalogue,
  users: {
    bootstrap: { state: "unclaimed", telegramId: null },
    bootstrapDescription: undefined,
    candidates: { status: "ready", value: [candidate] },
    members: [
      row({ id: "m-free", name: "Deletable", roleId: "role-open", canDelete: true }),
      row({ id: "m-kept", name: "Kept", roleId: "role-closed", canDelete: false }),
    ],
    roles,
    invitations: null,
    managed: null,
    closeManaged: spy("sheet.close", "Close panel"),
    deletion: null,
  },
  roles: { roles: { status: "ready", value: roles }, reading: closed, read: (role) => spy("access.role.read", `${role.permissions.length} permissions`), closeReading: spy("sheet.close.role", "Close panel") },
  notifications: { state: "ready", error: "", retry: null, saveStatus: "", games: [], subscriptions: {}, toggle: (id, label) => spy(`notifications.${id}`, label) },
};

const selectOf = (markup: string, label: string) => markup.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>.*?</select>`))?.[0] ?? "";
const optionValues = (select: string) => [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1]);

for (const skin of SKINS) {
  test(`${skin.name}: the role selects offer the assignable roles and lock a role the caller may not take away`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Access, { model }));
    assert.deepEqual(optionValues(selectOf(markup, "Role for Nikita")), ["role-open", "role-plain"], "the approval choice follows assignable");
    assert.deepEqual(optionValues(selectOf(markup, "Role for Deletable")), ["role-open", "role-plain"]);
    const locked = selectOf(markup, "Role for Kept");
    assert.deepEqual(optionValues(locked), ["role-closed"], "a role that is not assignable is shown alone");
    assert.match(locked, /disabled/);
  });

  test(`${skin.name}: Delete user is reachable exactly where the API says canDelete`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Access, { model }));
    assert.equal(markup.match(/data-action="access\.delete"/g)?.length, 1);
    const free = model.users.members[0]!;
    const kept = model.users.members[1]!;
    assert.ok(free.remove, "canDelete gives the verb");
    assert.equal(kept.remove, null, "no canDelete gives none, whatever the role");
    const only = { ...model, users: { ...model.users, members: [kept] } };
    assert.doesNotMatch(renderToStaticMarkup(createElement(skin.Access, { model: only })), /data-action="access\.delete"/);
  });

  test(`${skin.name}: the roles tab shows the catalogue's words for a role's permissions`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles" } }));
    assert.match(markup, /Does the first thing\./);
    assert.match(markup, /Does the second thing\./);
    assert.doesNotMatch(markup, /No description recorded/, "every permission the role holds is in the catalogue");
  });
}

test("console: the roles matrix lists every catalogue permission, grouped, also those no role holds", () => {
  const markup = renderToStaticMarkup(createElement(consoleSkin.Access, { model: { ...model, tab: "roles" } }));
  for (const entry of catalogue) {
    assert.match(markup, new RegExp(`>${entry.label}<`), `${entry.id} has a row`);
    assert.match(markup, new RegExp(`data-tip="${entry.description}"`), `${entry.id} carries its sentence`);
  }
  assert.match(markup, />Group One</);
  assert.match(markup, />Group Two</);
});

test("both skins key a waiting account by the row's id, so two platforms with one user id stay two rows", () => {
  const other: CandidateRow = { ...candidate, id: "discord:42", candidate: { ...candidate.candidate, platform: "discord", displayName: "Second" } };
  const two = { ...model, users: { ...model.users, candidates: { status: "ready" as const, value: [candidate, other] } } };
  const console = renderToStaticMarkup(createElement(consoleSkin.Access, { model: two }));
  assert.match(console, /requests\/telegram%3A42/);
  assert.match(console, /requests\/discord%3A42/);
  const terminal = renderToStaticMarkup(createElement(SKINS.find((skin) => skin.name === "Terminal")!.Access, { model: two }));
  assert.match(terminal, /Nikita/);
  assert.match(terminal, /Second/);
});
