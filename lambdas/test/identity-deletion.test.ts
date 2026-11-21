import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type Identity } from "../src/access/domain.ts";
import { type WorldRecord } from "../src/control-plane/world-registry.ts";
import { accessTable, type Item, type TableOptions } from "./access-table.ts";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { deleteIdentity, deletedUserName } = await import("../src/handlers/api/identity-deletion.ts");

const ids = {
  owner: "00000000-0000-4000-8000-0000000000a1",
  secondOwner: "00000000-0000-4000-8000-0000000000a2",
  target: "00000000-0000-4000-8000-0000000000b1",
  manager: "00000000-0000-4000-8000-0000000000c1",
  other: "00000000-0000-4000-8000-0000000000d1",
};

// Fixture personal data. None of it may reach the audit line.
const person = { name: "Fixture Person", email: "person@example.test", telegramId: "555000111", passwordSubject: "pw-subject-1" };

const profile = (identityId: string, roleId: string, extra: Item = {}): Item => ({
  pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: `name-${identityId.slice(-2)}`,
  role_id: roleId, direct_grants: [], status: "ACTIVE", gsi1pk: "IDENTITY#ACTIVE", gsi1sk: identityId, ...extra,
});

const caller = (item: Item): Identity => ({
  id: String(item.identity_id), displayName: String(item.display_name), roleId: String(item.role_id),
  directGrants: item.direct_grants as Identity["directGrants"],
});

function targetRecords(roleId = "operator"): Item[] {
  const t = ids.target;
  return [
    profile(t, roleId, { display_name: person.name, gsi1sk: person.name.toLowerCase() }),
    { pk: `IDENTITY#${t}`, sk: "SUBSCRIPTIONS", events: ["session.ready"] },
    { pk: `IDENTITY#${t}`, sk: "APPEARANCE", theme: "dark" },
    { pk: `IDENTITY#${t}`, sk: "LOGIN_PROVIDER#password", entity_type: "IDENTITY_LOGIN_PROVIDER", provider: "password", subject: person.passwordSubject },
    {
      pk: `TELEGRAM#${person.telegramId}`, sk: "ACCOUNT", platform: "telegram", platform_user_id: person.telegramId,
      display_name: person.name, username: "fixture_handle", identity_id: t, status: "APPROVED", gsi1pk: `IDENTITY#${t}`,
    },
    {
      pk: `ACCOUNT#password#${person.passwordSubject}`, sk: "ACCOUNT", platform: "password", platform_user_id: person.passwordSubject,
      display_name: person.name, email: person.email, identity_id: t, status: "APPROVED", gsi1pk: `IDENTITY#${t}`,
    },
    { pk: `CREDENTIAL#EMAIL#${person.email}`, sk: "PASSWORD", subject: person.passwordSubject, email: person.email, display_name: person.name, password_hash: "hash" },
    { pk: "LOGIN_SESSION#s1", sk: "REFRESH", entity_type: "LOGIN_SESSION", status: "ACTIVE", provider: "telegram", subject: person.telegramId, display_name: person.name, gsi1pk: `ACCOUNT#telegram#${person.telegramId}` },
    { pk: "LOGIN_SESSION#s2", sk: "REFRESH", entity_type: "LOGIN_SESSION", status: "REVOKED", provider: "password", subject: person.passwordSubject, email: person.email, gsi1pk: `ACCOUNT#password#${person.passwordSubject}` },
    { pk: "OAUTH#REFRESH#r1", sk: "REFRESH", status: "ROTATED", identity_id: t },
    { pk: "OAUTH#REFRESH#r2", sk: "REFRESH", status: "ACTIVE", identity_id: t },
    { pk: "OAUTH#CODE#c1", sk: "CODE", status: "USED", identity_id: t },
    { pk: "EMAIL_ACTION#e1", sk: "TOKEN", entity_type: "EMAIL_ACTION_TOKEN", subject: person.passwordSubject, email: person.email, display_name: person.name },
    { pk: "ACCESS_INVITATION#i1", sk: "TOKEN", entity_type: "ACCESS_INVITATION", status: "USED", created_by: ids.owner, identity_id: t, delivery_email: person.email },
    { pk: "ACCESS_INVITATION#i1", sk: `PROOF#password#${person.passwordSubject}`, entity_type: "ACCESS_INVITATION_PROOF", status: "USED" },
    { pk: "ACCESS_INVITATION#i2", sk: "TOKEN", entity_type: "ACCESS_INVITATION", status: "PENDING", created_by: t, delivery_email: "invitee@example.test" },
    { pk: "ACCESS_INVITATION#i3", sk: "TOKEN", entity_type: "ACCESS_INVITATION", status: "USED", created_by: t, identity_id: ids.other },
    { pk: "INVITATION#p1", sk: "EVENT", sender_identity_id: t, recipient_identity_ids: [ids.owner], gsi1pk: `INVITATION#SENDER#${t}#GAME#minecraft#WORLD#w1` },
    { pk: "CONSOLE#w1", sk: "2026-11-20T10:00:00.000Z#cmd1", identity_id: t, display_name: person.name, command: "list" },
    { pk: "DOWNLOAD#w1", sk: "2026-11-20T11:00:00.000Z#d1", identity_id: t, display_name: person.name, key: "worlds/w1/archives/a.tar.zst" },
  ];
}

function unrelatedRecords(): Item[] {
  return [
    profile(ids.owner, "owner"),
    { pk: "TELEGRAM#100", sk: "ACCOUNT", platform: "telegram", platform_user_id: "100", identity_id: ids.owner, gsi1pk: `IDENTITY#${ids.owner}` },
    { pk: "LOGIN_SESSION#s9", sk: "REFRESH", entity_type: "LOGIN_SESSION", status: "ACTIVE", provider: "telegram", subject: "100", gsi1pk: "ACCOUNT#telegram#100" },
    { pk: "OAUTH#REFRESH#r9", sk: "REFRESH", status: "ACTIVE", identity_id: ids.owner },
    { pk: "OAUTH#CLIENT#client-1", sk: "CLIENT", name: "Agent" },
    profile(ids.other, "player", { created_by: ids.target, approved_by: ids.target }),
    { pk: "INVITATION#p2", sk: "EVENT", sender_identity_id: ids.owner, recipient_identity_ids: [ids.target] },
    { pk: "CONSOLE#w1", sk: "2026-11-20T09:00:00.000Z#cmd0", identity_id: ids.owner, display_name: "name-a1", command: "say hi" },
    { pk: "ACCESS_INVITATION#i4", sk: "TOKEN", entity_type: "ACCESS_INVITATION", status: "PENDING", created_by: ids.owner },
  ];
}

const world = (worldId: string, identityId: string, displayName: string): WorldRecord => ({
  worldId, gameId: "minecraft", displayName: worldId, status: "active", placement: "fleet", connectivity: "zerotier",
  preset: { presetId: "vanilla", release: "1.0.0" },
  currentGeneration: { generationId: "g1", release: "1.0.0", createdAt: "2026-11-01T00:00:00.000Z" },
  generations: [],
  gameSettings: { values: {}, updatedAt: "2026-11-02T00:00:00.000Z", updatedBy: { identityId, displayName } },
  whitelist: { names: ["Steve"], updatedAt: "2026-11-02T00:00:00.000Z", updatedBy: { identityId, displayName } },
} as unknown as WorldRecord);

// World records by id, each with an ETag that changes on every write. `edits`
// writes a concurrent change before the next replace, once per entry.
function worldStore(records: WorldRecord[], edits: string[] = [], failList = false) {
  const stored = new Map(records.map((record) => [record.worldId, { record, etag: `"${record.worldId}-0"` }]));
  let version = 0;
  const replaced: string[] = [];
  return {
    stored,
    replaced,
    store: () => ({
      list: async () => {
        if (failList) throw Object.assign(new Error("denied"), { name: "AccessDenied" });
        return [...stored.values()].map((entry) => entry.record);
      },
      read: async (worldId: string) => stored.get(worldId) ?? null,
      replace: async (record: WorldRecord, etag: string) => {
        const current = stored.get(record.worldId)!;
        const edit = edits.indexOf(record.worldId);
        if (edit >= 0) {
          edits.splice(edit, 1);
          stored.set(record.worldId, { record: current.record, etag: `"${record.worldId}-edit${(version += 1)}"` });
          throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed" });
        }
        if (current.etag !== etag) throw Object.assign(new Error("precondition"), { name: "PreconditionFailed" });
        replaced.push(record.worldId);
        stored.set(record.worldId, { record, etag: `"${record.worldId}-${(version += 1)}"` });
      },
    }),
  };
}

function fixture(t: TestContext, items: Item[], options: TableOptions = {}) {
  const audit: string[] = [];
  t.mock.method(console, "info", (line: string) => { audit.push(line); });
  t.mock.method(console, "error", () => undefined);
  return { ...accessTable(t, document, items, options), audit };
}

test("every record of the person goes, and records about other people stay", async (t) => {
  const f = fixture(t, [...targetRecords(), ...unrelatedRecords()]);
  const worlds = worldStore([world("w1", ids.target, person.name), world("w2", ids.owner, "name-a1")]);
  const result = await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worlds.store);
  assert.equal(result.statusCode, 204);

  const left = [...f.table.values()];
  assert.deepEqual(left.filter((item) => String(item.pk).includes(ids.target)), [], "the identity partition is gone");
  for (const [pk, sk] of [
    [`TELEGRAM#${person.telegramId}`, "ACCOUNT"], [`ACCOUNT#password#${person.passwordSubject}`, "ACCOUNT"],
    [`CREDENTIAL#EMAIL#${person.email}`, "PASSWORD"], ["LOGIN_SESSION#s1", "REFRESH"], ["LOGIN_SESSION#s2", "REFRESH"],
    ["OAUTH#REFRESH#r1", "REFRESH"], ["OAUTH#REFRESH#r2", "REFRESH"], ["OAUTH#CODE#c1", "CODE"], ["EMAIL_ACTION#e1", "TOKEN"],
    ["ACCESS_INVITATION#i1", "TOKEN"], ["ACCESS_INVITATION#i1", `PROOF#password#${person.passwordSubject}`], ["INVITATION#p1", "EVENT"],
  ]) assert.equal(f.get(pk!, sk!), undefined, `${pk} ${sk} is deleted`);

  for (const item of unrelatedRecords()) assert.deepEqual(f.get(String(item.pk), String(item.sk)), item, `${String(item.pk)} is untouched`);

  assert.equal(f.get("ACCESS_INVITATION#i2", "TOKEN")?.status, "REVOKED", "a pending invitation the person sent is revoked");
  assert.equal(f.get("ACCESS_INVITATION#i3", "TOKEN")?.status, "USED", "a redeemed one is left to its TTL");

  const command = f.get("CONSOLE#w1", "2026-11-20T10:00:00.000Z#cmd1")!;
  assert.equal(command.display_name, undefined);
  assert.equal(command.identity_id, ids.target, "console history keeps the pseudonymous id");
  const download = f.get("DOWNLOAD#w1", "2026-11-20T11:00:00.000Z#d1")!;
  assert.equal(download.display_name, undefined);
  assert.equal(download.identity_id, ids.target);

  const rewritten = worlds.stored.get("w1")!.record;
  assert.deepEqual(rewritten.gameSettings?.updatedBy, { identityId: ids.target, displayName: deletedUserName });
  assert.deepEqual(rewritten.whitelist?.updatedBy, { identityId: ids.target, displayName: deletedUserName });
  assert.deepEqual(rewritten.whitelist?.names, ["Steve"]);
  assert.deepEqual(worlds.replaced, ["w1"], "a world the person did not touch is not written");

  assert.equal(f.audit.length, 1);
  assert.deepEqual(JSON.parse(f.audit[0]!), {
    ...JSON.parse(f.audit[0]!),
    event: "identity_deleted", actorIdentityId: ids.owner, deletedIdentityId: ids.target, roleId: "operator",
    removed: { accounts: 2, credentials: 1, loginSessions: 2, oauth: 3, emailActions: 1, invitations: 2, playerInvitations: 1 },
    revoked: { accessInvitations: 1 },
    anonymised: { console: 1, downloads: 1, worlds: 1, bootstrap: 0 },
    sweep2: "complete",
  });
});

test("the audit line holds ids and counts only, never the person's data", async (t) => {
  const f = fixture(t, [...targetRecords(), ...unrelatedRecords()]);
  await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worldStore([world("w1", ids.target, person.name)]).store);
  const audit = JSON.parse(f.audit[0]!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(audit).sort(), ["actorIdentityId", "anonymised", "at", "deletedIdentityId", "event", "removed", "revoked", "roleId", "sweep2"]);
  for (const value of [person.name, person.email, person.telegramId, person.passwordSubject, "fixture_handle", "password", "telegram"]) {
    assert.ok(!f.audit[0]!.includes(value), `the audit line must not hold ${value}`);
  }
});

test("refusals come in order: self, missing, Owner without the grant, last Owner", async (t) => {
  const owner = profile(ids.owner, "owner");
  const manager = profile(ids.manager, "operator", { direct_grants: ["access.manage"] });

  await t.test("self", async (t) => {
    const f = fixture(t, [owner, ...targetRecords("owner")]);
    assert.deepEqual(JSON.parse((await deleteIdentity(caller(owner), ids.owner, worldStore([]).store)).body), { error: "self_delete_forbidden" });
    assert.ok(f.get(`IDENTITY#${ids.owner}`, "PROFILE"));
  });

  await t.test("missing target", async (t) => {
    const f = fixture(t, [owner]);
    assert.equal((await deleteIdentity(caller(owner), ids.target, worldStore([]).store)).statusCode, 204);
    assert.deepEqual(f.audit, []);
  });

  await t.test("an Owner, by a manager without access.owner.grant", async (t) => {
    const f = fixture(t, [owner, manager, ...targetRecords("owner")]);
    const result = await deleteIdentity(caller(manager), ids.target, worldStore([]).store);
    assert.equal(result.statusCode, 403);
    assert.equal(f.get(`IDENTITY#${ids.target}`, "PROFILE")?.role_id, "owner");
    assert.ok(f.get("LOGIN_SESSION#s1", "REFRESH"), "a refusal sweeps nothing");
  });

  await t.test("a non-Owner, by the same manager", async (t) => {
    fixture(t, [owner, manager, ...targetRecords("viewer")]);
    assert.equal((await deleteIdentity(caller(manager), ids.target, worldStore([]).store)).statusCode, 204);
  });

  await t.test("the last Owner, as the index counts", async (t) => {
    const f = fixture(t, [owner, ...targetRecords("owner")], { ownerCount: () => 1 });
    const result = await deleteIdentity(caller(owner), ids.target, worldStore([]).store);
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: "last_owner" });
    assert.ok(f.get(`IDENTITY#${ids.target}`, "PROFILE"));
  });
});

test("a second call answers 204 and writes no second audit line", async (t) => {
  const f = fixture(t, [...targetRecords(), ...unrelatedRecords()]);
  const worlds = worldStore([world("w1", ids.target, person.name)]);
  assert.equal((await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worlds.store)).statusCode, 204);
  const writes = f.sent.length;
  assert.equal((await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worlds.store)).statusCode, 204);
  assert.equal(f.audit.length, 1);
  assert.equal(f.sent.length, writes + 1, "the repeat reads the profile and stops");
});

test("transaction cancellation reasons map to answers", async (t) => {
  const owner = profile(ids.owner, "owner");
  const cases: Array<[string, (table: Map<string, Item>) => void, number, string | null]> = [
    ["the caller was removed meanwhile", (table) => { table.delete(`IDENTITY#${ids.owner}\u0000PROFILE`); }, 409, "caller_changed"],
    ["the caller lost the Owner role meanwhile", (table) => { table.get(`IDENTITY#${ids.owner}\u0000PROFILE`)!.role_id = "operator"; }, 409, "caller_changed"],
    ["someone else deleted the target first", (table) => { table.delete(`IDENTITY#${ids.target}\u0000PROFILE`); }, 204, null],
    ["the target's role changed meanwhile", (table) => { table.get(`IDENTITY#${ids.target}\u0000PROFILE`)!.role_id = "viewer"; }, 409, "identity_changed"],
    ["an account was moved meanwhile", (table) => { table.get(`TELEGRAM#${person.telegramId}\u0000ACCOUNT`)!.identity_id = ids.other; }, 409, "identity_changed"],
    ["the credential was replaced meanwhile", (table) => { table.get(`CREDENTIAL#EMAIL#${person.email}\u0000PASSWORD`)!.subject = "other"; }, 409, "identity_changed"],
    ["another transaction held an item", () => {
      throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] });
    }, 409, "deletion_conflict"],
  ];
  for (const [name, change, status, error] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t, [owner, profile(ids.secondOwner, "owner"), ...targetRecords("owner")], { beforeTransact: change });
      const result = await deleteIdentity(caller(owner), ids.target, worldStore([]).store);
      assert.equal(result.statusCode, status);
      if (error !== null) assert.deepEqual(JSON.parse(result.body), { error });
      assert.deepEqual(f.audit, [], "no audit line for a deletion that did not commit");
    });
  }
});

test("two Owners who delete each other at once leave one Owner", async (t) => {
  const first = profile(ids.owner, "owner");
  const second = profile(ids.secondOwner, "owner");
  const f = fixture(t, [first, second]);
  const results = await Promise.all([
    deleteIdentity(caller(first), ids.secondOwner, worldStore([]).store),
    deleteIdentity(caller(second), ids.owner, worldStore([]).store),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [204, 409]);
  const owners = [...f.table.values()].filter((item) => item.sk === "PROFILE" && item.role_id === "owner");
  assert.equal(owners.length, 1);
  assert.equal(f.audit.length, 1);
});

test("the bootstrap Owner's claim is kept without their Telegram id or identity", async (t) => {
  const f = fixture(t, [
    profile(ids.owner, "owner"),
    ...targetRecords("owner"),
    { pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: ids.target, telegram_id: person.telegramId, claimed_at: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.equal((await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worldStore([]).store)).statusCode, 204);
  const claim = f.get("SYSTEM", "BOOTSTRAP")!;
  assert.equal(claim.status, "CLAIMED");
  assert.equal(claim.identity_id, undefined);
  assert.equal(claim.telegram_id, undefined);
  assert.equal(typeof claim.owner_removed_at, "string");
  assert.equal(JSON.parse(f.audit[0]!).anonymised.bootstrap, 1);
});

test("a world record edited during the rewrite is read again, not overwritten", async (t) => {
  fixture(t, [profile(ids.owner, "owner"), ...targetRecords()]);
  const worlds = worldStore([world("w1", ids.target, person.name)], ["w1"]);
  assert.equal((await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worlds.store)).statusCode, 204);
  assert.equal(worlds.stored.get("w1")!.record.whitelist?.updatedBy.displayName, deletedUserName);
  assert.deepEqual(worlds.replaced, ["w1"]);
});

test("a failure after the commit is logged, and the deletion still answers 204", async (t) => {
  const f = fixture(t, [profile(ids.owner, "owner"), ...targetRecords()]);
  const result = await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worldStore([], [], true).store);
  assert.equal(result.statusCode, 204);
  assert.equal(f.get(`IDENTITY#${ids.target}`, "PROFILE"), undefined);
  assert.equal(JSON.parse(f.audit[0]!).sweep2, "incomplete");
});

test("a link made after the read is removed by the second sweep", async (t) => {
  const late = {
    pk: "ACCOUNT#google#g-late", sk: "ACCOUNT", platform: "google", platform_user_id: "g-late", identity_id: ids.target, gsi1pk: `IDENTITY#${ids.target}`,
  };
  let added = false;
  const f = fixture(t, [profile(ids.owner, "owner"), ...targetRecords()], {
    beforeTransact: (table) => {
      if (added) return;
      added = true;
      table.set(`${late.pk}\u0000ACCOUNT`, { ...late });
      table.set(`IDENTITY#${ids.target}\u0000LOGIN_PROVIDER#google`, { pk: `IDENTITY#${ids.target}`, sk: "LOGIN_PROVIDER#google", provider: "google", subject: "g-late" });
    },
  });
  assert.equal((await deleteIdentity(caller(profile(ids.owner, "owner")), ids.target, worldStore([]).store)).statusCode, 204);
  assert.equal(f.get(late.pk, "ACCOUNT"), undefined);
  assert.equal(f.get(`IDENTITY#${ids.target}`, "LOGIN_PROVIDER#google"), undefined);
});
