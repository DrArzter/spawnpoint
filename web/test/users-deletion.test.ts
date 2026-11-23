import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { identityDeletionRefusal } from "../src/api/contract.ts";
import type { SnackInput } from "../src/components/ui/Snackbar.tsx";
import { deleteMember, deletionConfirmation, memberRemoval } from "../src/core/data.ts";
import type { Member } from "../src/model.ts";
import { noop } from "./support/fixtures.ts";

// The API decides who may be deleted and says so in `canDelete`; the web reads it and works out nothing.
const owner: Member = { id: "identity-owner", name: "DrArzter", roleId: "role-a", links: [], canDelete: false };
const viewer: Member = { id: "identity-mira", name: " Mira ", roleId: "role-b", links: [], canDelete: true };

test("delete is offered where the API says canDelete, with the same verb on every row", () => {
  const remove = memberRemoval(viewer, noop);
  assert.equal(remove?.id, "access.delete");
  assert.equal(remove?.label, "Delete user");
  assert.equal(remove?.danger, true);
});

test("delete is not offered where the API says the caller may not, whatever the role", () => {
  assert.equal(memberRemoval(owner, noop), null);
  assert.equal(memberRemoval({ ...viewer, roleId: owner.roleId, canDelete: false }, noop), null);
  assert.equal(memberRemoval({ ...owner, canDelete: true }, noop)?.id, "access.delete");
});

test("the dialog says the plan's one line and waits for the trimmed name", () => {
  const dialog = (typed: string) => deletionConfirmation(viewer, { typed, setTyped: noop, busy: false, error: null, confirm: noop, cancel: noop });
  const empty = dialog("");
  assert.equal(empty.title, "Delete Mira?");
  assert.equal(empty.description, "Removes their sign-in methods, sessions and agent connections. This cannot be undone.");
  assert.equal(empty.destructive, true);
  assert.equal(empty.releaseChoice, null);
  assert.deepEqual({ label: empty.typedConfirmation?.label, expected: empty.typedConfirmation?.expected }, { label: "User name", expected: "Mira" });
  assert.equal(empty.confirm.label, "Delete user");
  assert.equal(empty.confirm.disabled, true);
  assert.equal(dialog("Mir").confirm.disabled, true);
  assert.equal(dialog("mira").confirm.disabled, true);
  assert.equal(dialog("Mira").confirm.disabled, false);
  assert.equal(deletionConfirmation(viewer, { typed: "Mira", setTyped: noop, busy: true, error: null, confirm: noop, cancel: noop }).confirm.disabled, true, "no second request while one runs");
});

function harness(remove: (id: string) => Promise<void>, managing: string | null) {
  const notes: SnackInput[] = [];
  let members: Member[] = [owner, viewer];
  let closed = false;
  const deps = { remove, members, onMembersChange: (next: Member[]) => { members = next; }, managing, closeManaged: () => { closed = true; }, notify: (note: SnackInput) => { notes.push(note); } };
  return { deps, notes, members: () => members, closed: () => closed };
}

test("a deletion removes the row, closes the panel that shows the person and says so", async () => {
  const run = harness(async () => undefined, viewer.id);
  assert.equal(await deleteMember(viewer, run.deps), null);
  assert.deepEqual(run.members().map((member) => member.id), [owner.id]);
  assert.equal(run.closed(), true);
  assert.deepEqual(run.notes, [{ tone: "success", message: "Mira was deleted." }]);
});

test("a deletion leaves another person's panel open", async () => {
  const run = harness(async () => undefined, owner.id);
  await deleteMember(viewer, run.deps);
  assert.equal(run.closed(), false);
});

test("a refusal keeps the row and hands the reason to the open dialog", async () => {
  const run = harness(async () => { throw new Error(identityDeletionRefusal(409, "last_owner")); }, viewer.id);
  assert.equal(await deleteMember(viewer, run.deps), "The last Owner cannot be deleted.");
  assert.equal(run.members().length, 2);
  assert.equal(run.closed(), false);
  assert.deepEqual(run.notes, [], "a snackbar would sit under the modal");
  const dialog = deletionConfirmation(viewer, { typed: "Mira", setTyped: noop, busy: false, error: "The last Owner cannot be deleted.", confirm: noop, cancel: noop });
  assert.equal(dialog.error, "The last Owner cannot be deleted.");
});

test("each refusal the API sends reads as a sentence", () => {
  assert.equal(identityDeletionRefusal(409, "self_delete_forbidden"), "You cannot delete yourself.");
  assert.equal(identityDeletionRefusal(409, "last_owner"), "The last Owner cannot be deleted.");
  assert.equal(identityDeletionRefusal(403, "forbidden"), "Your role cannot delete this user.");
  assert.equal(identityDeletionRefusal(500, undefined), "This user could not be deleted.");
});
