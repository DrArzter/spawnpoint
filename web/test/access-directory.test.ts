import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { AccessCandidate, AccessIdentity, AccessRoleDirectory } from "../src/api/contract.ts";
import { AccessDirectoryStore, candidateKey, readDirectory, type AccessDirectory, type DirectoryApi } from "../src/core/access-directory.ts";
import { accessRequests } from "../src/core/data.ts";
import type { SnackInput } from "../src/components/ui/Snackbar.tsx";
import type { Member } from "../src/model.ts";
import { aMember, aPermission, aRole } from "./support/fixtures.ts";

/*
 * One directory serves the rail's badge, the game home and the Access page. A
 * waiting account has one key (platform and platform user id), a decision on it
 * changes the count at once everywhere, and an older read never brings back
 * what a decision removed. The ids here are test data.
 */

const waiting = (platform: string, platformUserId: string, displayName: string): AccessCandidate => ({
  platform, platformUserId, displayName, username: null, email: null, photoUrl: null, status: "REQUESTED",
  firstSeenAt: "2026-09-14T18:10:00Z", lastSeenAt: "2026-09-14T18:10:00Z", requestedAt: "2026-09-14T18:10:00Z",
});

// Two platforms that happen to give two people the same user id.
const first = waiting("telegram", "42", "First");
const second = waiting("discord", "42", "Second");
const third = waiting("telegram", "77", "Third");

const identity = (id: string, roleId: string, canDelete: boolean): AccessIdentity => ({ id, displayName: id, roleId, directGrants: [], canDelete, links: [] });

const served: AccessRoleDirectory = {
  roles: [{ ...aRole({ id: "role-a", name: "Role A" }), version: 1 }, { ...aRole({ id: "role-b", name: "Role B" }), version: 1 }],
  permissions: [aPermission()],
  defaultRoleId: "role-a",
};

function fake(over: Partial<DirectoryApi> = {}) {
  const calls: string[] = [];
  let open = [first, second, third];
  let identities = [identity("person-1", "role-a", true)];
  const api: DirectoryApi = {
    loadCandidates: async () => [...open],
    loadIdentities: async () => [...identities],
    loadRoles: async () => served,
    approve: async (platform, platformUserId, roleId) => {
      calls.push(`approve ${platform}:${platformUserId} ${roleId ?? "-"}`);
      open = open.filter((item) => candidateKey(item) !== `${platform}:${platformUserId}`);
      identities = [...identities, identity(`person-${platformUserId}`, roleId ?? "role-a", true)];
      return { id: `person-${platformUserId}`, displayName: `Person ${platformUserId}`, roleId: roleId ?? "role-a" };
    },
    dismiss: async (platform, platformUserId) => {
      calls.push(`dismiss ${platform}:${platformUserId}`);
      open = open.filter((item) => candidateKey(item) !== `${platform}:${platformUserId}`);
    },
    changeRole: async (identityId, roleId) => {
      calls.push(`role ${identityId} ${roleId}`);
      identities = identities.map((item) => (item.id === identityId ? { ...item, roleId, canDelete: false } : item));
    },
    ...over,
  };
  const notes: SnackInput[] = [];
  const store = new AccessDirectoryStore(api, (note) => { notes.push(note); });
  return { store, notes, calls };
}

const self: Member = aMember({ id: "self", name: "Self", canDelete: false });
const view = (store: AccessDirectoryStore, canManage = true) => readDirectory(store.snapshot(), { self, ownRole: null, canManage }, { people: () => undefined, roles: () => undefined });
const keys = (store: AccessDirectoryStore) => {
  const { candidates } = view(store);
  return candidates.status === "ready" ? candidates.value.map(candidateKey) : [];
};

test("a waiting account has one key: its platform and its id there", () => {
  assert.equal(candidateKey(first), "telegram:42");
  assert.notEqual(candidateKey(first), candidateKey(second), "the same id on two platforms is two accounts");
});

test("the badge counts what the directory holds, and nothing before it is read", async () => {
  const { store } = fake();
  assert.equal(view(store).requestCount, null);
  await store.readPeople(false);
  assert.equal(view(store).requestCount, 3);
});

test("approve removes the one account it names, drops the count at once and reads the people again", async () => {
  const { store, notes, calls } = fake();
  await store.readRoles(false);
  await store.readPeople(false);
  await store.approve(first, "role-b");
  assert.deepEqual(keys(store), ["discord:42", "telegram:77"], "the account with the same id on another platform stays");
  assert.equal(view(store).requestCount, 2);
  assert.deepEqual(calls, ["approve telegram:42 role-b"]);
  assert.deepEqual(notes, [{ tone: "success", message: "Person 42 approved as Role B." }]);
  await store.readPeople(true);
  assert.ok(view(store).members.some((member) => member.id === "person-42"), "the new identity is in the list");
});

test("approve without a role sends none, so the API gives the default", async () => {
  const { store, calls, notes } = fake();
  await store.readPeople(false);
  await store.approve(third);
  assert.deepEqual(calls, ["approve telegram:77 -"]);
  assert.deepEqual(notes, [{ tone: "success", message: "Person 77 approved." }]);
});

test("dismiss drops the count the same way", async () => {
  const { store, notes } = fake();
  await store.readPeople(false);
  await store.dismiss(second);
  assert.deepEqual(keys(store), ["telegram:42", "telegram:77"]);
  assert.equal(view(store).requestCount, 2);
  assert.deepEqual(notes, [{ message: "Second dismissed." }]);
});

test("a refused decision keeps the list and the count, says why and frees the row", async () => {
  const { store, notes } = fake({ approve: async () => { throw new Error("This role no longer exists."); } });
  await store.readPeople(false);
  await store.approve(first, "role-b");
  assert.equal(view(store).requestCount, 3);
  assert.equal(view(store).working, null);
  assert.deepEqual(notes, [{ tone: "error", message: "This role no longer exists." }]);
});

test("an older read does not bring back what a decision removed", async () => {
  let release: (value: AccessCandidate[]) => void = () => undefined;
  const slow = new Promise<AccessCandidate[]>((resolve) => { release = resolve; });
  let reads = 0;
  const { store } = fake({ loadCandidates: () => (++reads === 1 ? Promise.resolve([first, second, third]) : slow) });
  await store.readPeople(false);
  const older = store.readPeople(true);
  await store.dismiss(first);
  release([first, second, third]);
  await older;
  assert.deepEqual(keys(store), ["discord:42", "telegram:77"]);
});

test("a role change shows at once and is read back, so canDelete follows the roles held", async () => {
  const { store } = fake();
  await store.readPeople(false);
  assert.equal(view(store).members[0]?.canDelete, true);
  await store.changeRole(view(store).members[0]!, "role-b");
  assert.equal(view(store).members[0]?.roleId, "role-b");
  assert.equal(view(store).members[0]?.canDelete, false, "the API's new answer replaced the old one");
});

test("a failed silent read keeps what is shown; a failed plain read says so", async () => {
  let fail = false;
  const { store } = fake({ loadCandidates: async () => { if (fail) throw new Error("boom"); return [first]; } });
  await store.readPeople(false);
  fail = true;
  await store.readPeople(true);
  assert.equal(view(store).requestCount, 1);
  await store.readPeople(false);
  const { candidates } = view(store);
  assert.equal(candidates.status, "error");
  assert.equal(view(store).requestCount, null);
});

test("a caller who may not manage access reads a refusal, no count, and only themselves", async () => {
  const { store } = fake();
  const read = view(store, false);
  assert.equal(read.requestCount, null);
  assert.equal(read.candidates.status === "error" && read.candidates.kind, "forbidden");
  assert.deepEqual(read.members, [self]);
});

test("the roles are read once for every page, and the default role is the API's", async () => {
  const { store } = fake();
  assert.equal(view(store).roles.defaultRoleId, null);
  await store.readRoles(false);
  assert.equal(view(store).roles.defaultRoleId, "role-a");
  assert.deepEqual(view(store).roles.permissions.map((entry) => entry.id), ["perm.one"]);
});

test("the game home's requests are the directory's candidates, under the same key", async () => {
  const { store } = fake();
  await store.readPeople(false);
  const read = view(store);
  const decisions: string[] = [];
  const directory = { ...read, setMembers: () => undefined, refresh: () => undefined, approve: async (candidate) => { decisions.push(`approve ${candidateKey(candidate)}`); }, dismiss: async (candidate) => { decisions.push(`dismiss ${candidateKey(candidate)}`); }, changeRole: async () => undefined } satisfies AccessDirectory;
  const { requests, actions } = accessRequests(directory);
  assert.equal(requests?.status, "ready");
  const ids = requests?.status === "ready" ? requests.value.map((row) => row.id) : [];
  assert.deepEqual(ids, ["telegram:42", "discord:42", "telegram:77"], "the same ids as the Access page's rows");
  actions("discord:42")?.approve.run();
  actions("telegram:77")?.dismiss.run();
  assert.deepEqual(decisions, ["approve discord:42", "dismiss telegram:77"]);
  assert.equal(actions("none:0"), null);
});
