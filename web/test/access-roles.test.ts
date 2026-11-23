import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { API_ERROR_TEXT } from "../src/api/error-text.ts";
import { memberRemoval, roleEditAction, roleRemoveAction } from "../src/core/data.ts";
import type { AccessModel, CandidateRow, MemberRow, RoleEditorModel } from "../src/core/models.ts";
import { defaultRoleChoice, offeredPermissions, permissionRows, protectedRoleName, ROLE_ID_PATTERN, roleChoice, roleIdFor, rolePermissions } from "../src/core/roles.ts";
import { SKINS } from "../src/skins/index.ts";
import { consoleSkin } from "../src/skins/console/index.ts";
import { aMember, aPermission, aRole, aRolesModel, noop, spy } from "./support/fixtures.ts";

/*
 * The web keeps no role ids and no owner rules. What a caller may give, what a
 * caller may delete and what a permission means all come from the API, and both
 * skins draw them. The ids below are test data; no role here is special to the code.
 */

const open = aRole({ id: "role-open", name: "Open role", permissions: ["perm.one"] });
const closed = aRole({ id: "role-closed", name: "Closed role", permissions: ["perm.one", "perm.two"], protected: true, assignable: false, editable: false });
const plain = aRole({ id: "role-plain", name: "Plain role", permissions: [], builtIn: false, deletable: true });
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

function row(over: { id: string; name: string; roleId: string; canDelete: boolean; photoUrl?: string | null }): MemberRow {
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
      row({ id: "m-free", name: "Deletable", roleId: "role-open", canDelete: true, photoUrl: "https://t.me/i/userpic/320/deletable.jpg" }),
      row({ id: "m-kept", name: "Kept", roleId: "role-closed", canDelete: false }),
    ],
    roles,
    invitations: null,
    managed: null,
    closeManaged: spy("sheet.close", "Close panel"),
    deletion: null,
  },
  roles: aRolesModel(roles, { reading: closed }),
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

  test(`${skin.name}: a person in the people list shows the photo of a linked account, and initials without one`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Access, { model }));
    assert.match(markup, /<img[^>]*src="https:\/\/t\.me\/i\/userpic\/320\/deletable\.jpg"/);
    assert.doesNotMatch(markup, /<img[^>]*alt="Kept profile"/);
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

// --- the role editor (ADR-0083) ----------------------------------------------------

const held = aRole({ id: "role-held", name: "Held role", builtIn: false, holders: 2 });

test("edit and delete follow the flags the API serves, with the reason as the hint", () => {
  assert.equal(roleEditAction(open, noop).disabled, false);
  const edit = roleEditAction(closed, noop);
  assert.equal(edit.disabled, true, "a protected role cannot be edited");
  assert.match(edit.hint ?? "", /cannot be changed/);
  assert.equal(roleRemoveAction(plain, "role-open", noop).disabled, false);
  assert.match(roleRemoveAction(open, "role-other", noop).hint ?? "", /built-in/i, "a built-in role cannot be deleted");
  assert.match(roleRemoveAction(held, "role-other", noop).hint ?? "", /2 people hold/, "a held role says how many hold it");
  assert.match(roleRemoveAction(aRole({ id: "role-d", builtIn: false }), "role-d", noop).hint ?? "", /default role/);
});

test("the editor offers every catalogue permission but a reserved one, and locks what the caller lacks", () => {
  const withReserved = [...catalogue, aPermission({ id: "perm.reserved", group: "Group Two", label: "Reserved", reserved: true })];
  const offered = offeredPermissions(withReserved, new Set(["perm.one", "perm.reserved"]));
  assert.deepEqual(offered.map((row) => row.permission.id), ["perm.one", "perm.two", "perm.idle"], "a reserved permission is never offered");
  assert.deepEqual(offered.map((row) => row.locked), [false, true, true], "only held permissions can be changed");
});

test("the default role choice never offers the protected role", () => {
  assert.deepEqual(defaultRoleChoice(roles, "role-open", false).options.map((option) => option.value), ["role-open", "role-plain"]);
  assert.equal(defaultRoleChoice(roles, "role-open", true).disabled, true);
});

test("a role id is a slug, made from the name until typed", () => {
  assert.equal(roleIdFor("Night Operator!"), "night-operator");
  assert.ok(ROLE_ID_PATTERN.test("night-operator"));
  assert.ok(!ROLE_ID_PATTERN.test("Night"));
});

function editorOf(over: Partial<RoleEditorModel> = {}): RoleEditorModel {
  return {
    mode: "edit", title: "Edit Open role", id: "role-open", setId: noop, idError: null, name: "Open role", setName: noop, description: "A role.", setDescription: noop,
    permissions: offeredPermissions(catalogue, new Set(["perm.one"])).map(({ permission, locked }) => ({ permission, checked: permission.id === "perm.one", toggle: spy(`access.role.permission.${permission.id}`, permission.label, { disabled: locked, hint: locked ? "You do not hold this permission." : undefined }) })),
    error: "Someone changed this role. The list is reloaded.", submit: spy("access.role.save", "Save role"), cancel: spy("access.role.cancel", "Cancel"), ...over,
  };
}

const tagsOf = (markup: string, action: string) => markup.match(new RegExp(`<[^>]*data-action="${action.replaceAll(".", "\\.")}"[^>]*>`, "g")) ?? [];
const refusedTag = (tag: string) => /aria-disabled="true"|disabled=""/.test(tag);

for (const skin of SKINS) {
  test(`${skin.name}: the roles tab reaches create, edit and delete where the flags allow`, () => {
    // One role per page, so every Edit and Delete on it is that role's.
    const free = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel([plain], { reading: plain }) } }));
    assert.match(free, /data-action="access\.role\.create"/);
    for (const id of ["access.role.edit", "access.role.delete"]) {
      assert.ok(tagsOf(free, id).length > 0 && tagsOf(free, id).every((tag) => !refusedTag(tag)), `${id} is reachable on a free role`);
    }
    const fixed = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel([closed], { reading: closed }) } }));
    for (const id of ["access.role.edit", "access.role.delete"]) {
      assert.ok(tagsOf(fixed, id).length > 0 && tagsOf(fixed, id).every(refusedTag), `${id} is refused on the protected role`);
    }
    const heldMarkup = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel([held], { reading: held }) } }));
    assert.ok(tagsOf(heldMarkup, "access.role.delete").every(refusedTag), "a held role cannot be deleted");
  });

  test(`${skin.name}: the editor draws only offered permissions, locks the ones not held, and shows the 409 text`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel(roles, { editor: editorOf() }) } }));
    assert.equal(refusedTag(tagsOf(markup, "access.role.permission.perm.one")[0] ?? ""), false);
    assert.equal(refusedTag(tagsOf(markup, "access.role.permission.perm.two")[0] ?? ""), true, "a permission the caller lacks is locked");
    assert.match(markup, /Someone changed this role\. The list is reloaded\./);
  });

  test(`${skin.name}: creating asks for an id, editing does not`, () => {
    const create = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel(roles, { editor: editorOf({ mode: "create", title: "New role", error: null }) }) } }));
    assert.match(create, />ID</);
    const edit = renderToStaticMarkup(createElement(skin.Access, { model: { ...model, tab: "roles", roles: aRolesModel(roles, { editor: editorOf({ error: null }) }) } }));
    assert.doesNotMatch(edit, />ID</);
  });
}

test("the role refusals have text", () => {
  for (const code of ["role_changed", "role_in_use", "role_exists", "role_protected", "role_built_in", "invalid_role", "reserved_permission", "unknown_role"]) {
    assert.ok(API_ERROR_TEXT[code], `${code} has text`);
  }
  assert.match(API_ERROR_TEXT.role_changed!, /Someone changed this role/);
});
