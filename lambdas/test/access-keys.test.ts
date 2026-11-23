import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { observeAccount, requestAccountAccess } from "../src/access/account-writes.ts";
import { createIdentity, loginProviderMarker } from "../src/access/identity-creation.ts";
import * as keys from "../src/access/keys.ts";

// Stored data: each expectation is the literal that production holds today.
test("every key builder returns today's literal", () => {
  assert.equal(keys.accessIndexName, "gsi1");
  assert.equal(keys.identityPartition("i1"), "IDENTITY#i1");
  assert.deepEqual(keys.profileKey("i1"), { pk: "IDENTITY#i1", sk: "PROFILE" });
  assert.deepEqual(keys.roleKey("moderator"), { pk: "ROLE#moderator", sk: "DEFINITION" });
  assert.equal(keys.roleIndex, "ROLE");
  assert.deepEqual(keys.accessDefaultsKey, { pk: "SYSTEM", sk: "ACCESS_DEFAULTS" });
  assert.deepEqual(keys.identitySettingKey("i1", "SUBSCRIPTIONS"), { pk: "IDENTITY#i1", sk: "SUBSCRIPTIONS" });
  assert.deepEqual(keys.identitySettingKey("i1", "APPEARANCE"), { pk: "IDENTITY#i1", sk: "APPEARANCE" });
  assert.deepEqual(keys.loginProviderKey("i1", "google"), { pk: "IDENTITY#i1", sk: "LOGIN_PROVIDER#google" });
  assert.equal(keys.accountKeyFor("telegram", "42"), "TELEGRAM#42");
  assert.equal(keys.accountKeyFor("google", "g-1"), "ACCOUNT#google#g-1");
  assert.equal(keys.accountKeyFor("password", "p-1"), "ACCOUNT#password#p-1");
  assert.deepEqual(keys.accountItemKey("telegram", "42"), { pk: "TELEGRAM#42", sk: "ACCOUNT" });
  assert.deepEqual(keys.accountItemKey("google", "g-1"), { pk: "ACCOUNT#google#g-1", sk: "ACCOUNT" });
  assert.deepEqual(keys.candidateIndex, {
    requested: "CANDIDATE#REQUESTED", observed: "CANDIDATE#OBSERVED", dismissed: "CANDIDATE#DISMISSED",
  });
  assert.equal(keys.activeIdentityIndex, "IDENTITY#ACTIVE");
  assert.equal(keys.identityIndex("i1"), "IDENTITY#i1");
  // Login sessions index Telegram under the provider-neutral shape too.
  assert.equal(keys.sessionAccountIndex("telegram", "42"), "ACCOUNT#telegram#42");
  assert.equal(keys.sessionAccountIndex("password", "p-1"), "ACCOUNT#password#p-1");
  assert.deepEqual(keys.oauthClientKey("c1"), { pk: "OAUTH#CLIENT#c1", sk: "CLIENT" });
  assert.deepEqual(keys.oauthCredentialKey("CODE", "h"), { pk: "OAUTH#CODE#h", sk: "CODE" });
  assert.deepEqual(keys.oauthCredentialKey("REFRESH", "h"), { pk: "OAUTH#REFRESH#h", sk: "REFRESH" });
  assert.equal(keys.oauthCredentialPrefix("CODE"), "OAUTH#CODE#");
  assert.equal(keys.oauthCredentialPrefix("REFRESH"), "OAUTH#REFRESH#");
  assert.deepEqual(keys.emailActionKey("h"), { pk: "EMAIL_ACTION#h", sk: "TOKEN" });
  assert.equal(keys.emailActionPrefix, "EMAIL_ACTION#");
  assert.deepEqual(keys.accessInvitationKey("h"), { pk: "ACCESS_INVITATION#h", sk: "TOKEN" });
  assert.deepEqual(keys.accessInvitationProofKey("h", "google", "g-1"), { pk: "ACCESS_INVITATION#h", sk: "PROOF#google#g-1" });
  assert.equal(keys.accessInvitationProofSort("google", "g-1"), "PROOF#google#g-1");
  assert.equal(keys.accessInvitationPrefix, "ACCESS_INVITATION#");
  assert.equal(keys.createdAccessInvitationIndex, "ACCESS_INVITATION#CREATED");
  assert.deepEqual(keys.playerInvitationKey("v1"), { pk: "INVITATION#v1", sk: "EVENT" });
  assert.equal(keys.playerInvitationPrefix, "INVITATION#");
  assert.equal(keys.playerInvitationSenderIndex("i1", "minecraft", "w1"), "INVITATION#SENDER#i1#GAME#minecraft#WORLD#w1");
  assert.equal(keys.consolePartition("w1"), "CONSOLE#w1");
  assert.equal(keys.consolePrefix, "CONSOLE#");
  assert.equal(keys.downloadPartition("w1"), "DOWNLOAD#w1");
  assert.equal(keys.downloadPrefix, "DOWNLOAD#");
});

test("the parsers read back what the builders write", () => {
  assert.deepEqual(keys.parseAccountKey(keys.accountKeyFor("telegram", "42")), { provider: "telegram", subject: "42" });
  assert.deepEqual(keys.parseAccountKey(keys.accountKeyFor("google", "a#b")), { provider: "google", subject: "a#b" });
  assert.equal(keys.parseAccountKey("IDENTITY#i1"), null);
  assert.equal(keys.identityIdFromPartition(keys.identityPartition("i1")), "i1");
  assert.equal(keys.identityIdFromPartition("TELEGRAM#42"), null);
  assert.equal(keys.isLoginProviderSort(keys.loginProviderKey("i1", "google").sk), true);
  assert.equal(keys.isLoginProviderSort("PROFILE"), false);
});

test("createIdentity writes the profile, the account link and the provider marker", () => {
  const items = createIdentity({
    tableName: "access", identityId: "i1", account: { provider: "google", subject: "g-1" },
    displayName: "Some Person", roleId: "viewer", directGrants: ["status.read"], createdBy: "i0", now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(items, [
    { Put: { TableName: "access", Item: {
      pk: "IDENTITY#i1", sk: "PROFILE", identity_id: "i1", display_name: "Some Person",
      role_id: "viewer", direct_grants: ["status.read"], status: "ACTIVE", created_at: "2026-01-01T00:00:00.000Z",
      created_by: "i0", gsi1pk: "IDENTITY#ACTIVE", gsi1sk: "some person",
    }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: { TableName: "access", Key: { pk: "ACCOUNT#google#g-1", sk: "ACCOUNT" },
      UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":identityId": "i1", ":approved": "APPROVED", ":linked": "IDENTITY#i1", ":now": "2026-01-01T00:00:00.000Z", ":by": "i0" },
    } },
    { Put: { TableName: "access", Item: {
      pk: "IDENTITY#i1", sk: "LOGIN_PROVIDER#google", entity_type: "IDENTITY_LOGIN_PROVIDER",
      provider: "google", subject: "g-1", created_at: "2026-01-01T00:00:00.000Z",
    }, ConditionExpression: "attribute_not_exists(pk)" } },
  ]);
});

test("a Telegram identity keeps its Telegram account key and marker", () => {
  const items = createIdentity({
    tableName: "access", identityId: "i2", account: { provider: "telegram", subject: "42" },
    displayName: "Owner", roleId: "owner", directGrants: [], createdBy: "bootstrap", now: "t",
  });
  assert.deepEqual(items[1]?.Update?.Key, { pk: "TELEGRAM#42", sk: "ACCOUNT" });
  assert.deepEqual(items[2]?.Put?.Item, loginProviderMarker("i2", "telegram", "42", "t"));
  assert.equal(items[2]?.Put?.Item?.sk, "LOGIN_PROVIDER#telegram");
});

test("the API's observation sets the attributes it always set", () => {
  const input = observeAccount("access", {
    provider: "google", subject: "g-1", displayName: "Name", username: null, photoUrl: "p", email: "e@example.test",
  }, false, "t");
  assert.deepEqual(input.Key, { pk: "ACCOUNT#google#g-1", sk: "ACCOUNT" });
  assert.equal(input.UpdateExpression, "SET " + [
    "platform = :platform", "platform_user_id = :platformUserId", "display_name = :displayName", "username = :username",
    "first_seen_at = if_not_exists(first_seen_at, :now)", "last_seen_at = :now",
    "#status = if_not_exists(#status, :candidateStatus)", "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)", "gsi1sk = :now",
    "photo_url = :photoUrl", "email = :email",
  ].join(", "));
  assert.equal(input.ExpressionAttributeValues?.[":candidateStatus"], "OBSERVED");
  assert.equal(input.ExpressionAttributeValues?.[":candidateIndex"], "CANDIDATE#OBSERVED");
});

test("the bot's observation leaves the photo and email alone, and sets a direct chat only when given", () => {
  const group = observeAccount("access", { provider: "telegram", subject: "42", displayName: "N", username: null, chatId: "-7" }, false, "t");
  assert.deepEqual(group.Key, { pk: "TELEGRAM#42", sk: "ACCOUNT" });
  assert.match(String(group.UpdateExpression), /chat_id = :chatId/);
  assert.doesNotMatch(String(group.UpdateExpression), /direct_chat_id|photo_url|email/);
  const direct = observeAccount("access", { provider: "telegram", subject: "42", displayName: "N", username: "u", chatId: "42", directChatId: "42" }, true, "t");
  assert.match(String(direct.UpdateExpression), /direct_chat_id = :directChatId/);
  assert.equal(direct.ExpressionAttributeValues?.[":candidateStatus"], "REQUESTED");
  assert.equal(direct.ExpressionAttributeValues?.[":candidateIndex"], "CANDIDATE#REQUESTED");
});

test("an access request fails once an identity is linked, and optionally when the account is missing", () => {
  const strict = requestAccountAccess("access", "google", "g-1", "t", true);
  assert.equal(strict.ConditionExpression, "attribute_exists(pk) AND attribute_not_exists(identity_id)");
  assert.deepEqual(strict.Key, { pk: "ACCOUNT#google#g-1", sk: "ACCOUNT" });
  assert.equal(strict.ExpressionAttributeValues?.[":candidateIndex"], "CANDIDATE#REQUESTED");
  assert.equal(requestAccountAccess("access", "telegram", "42", "t", false).ConditionExpression, "attribute_not_exists(identity_id)");
});

async function sources(directory: URL): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith(".ts") && entry.name !== "keys.ts") found.push(await readFile(path, "utf8").then((text) => `${path.pathname}\n${text}`));
  }
  return found;
}

test("no module outside keys.ts spells an access-table key or index value", async () => {
  const shapes = /IDENTITY#|TELEGRAM#|ACCOUNT#|CANDIDATE#|"gsi1"|LOGIN_PROVIDER#|OAUTH#|EMAIL_ACTION#|INVITATION#|CONSOLE#|DOWNLOAD#/;
  for (const source of await sources(new URL("../src/", import.meta.url))) {
    const [path, ...body] = source.split("\n");
    assert.doesNotMatch(body.join("\n"), shapes, `${path} spells an access-table key`);
  }
});
