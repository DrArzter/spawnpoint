import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { identities } = await import("../src/handlers/api/access.ts");

const owner = { id: "owner-1", displayName: "Owner", roleId: "owner", directGrants: [] } as const;

type Link = Readonly<{ platform: string; verified: boolean }>;

// One active identity with a Telegram account and an email one, and whichever
// credential the table is told to hold for that address.
function storage(t: TestContext, credential: Record<string, unknown> | undefined) {
  const lookups: string[] = [];
  t.mock.method(document, "send", async (command: unknown) => {
    const input = (command as { input: { Key?: { pk: string }; ExpressionAttributeValues?: Record<string, string> } }).input;
    const key = input.Key?.pk;
    if (typeof key === "string" && key.startsWith("CREDENTIAL#EMAIL#")) {
      lookups.push(key);
      return credential === undefined ? {} : { Item: credential };
    }
    const value = input.ExpressionAttributeValues?.[":state"] ?? input.ExpressionAttributeValues?.[":identity"];
    if (value === "IDENTITY#ACTIVE") return { Items: [{ identity_id: "id-1", display_name: "Someone", role_id: "player" }] };
    if (value === "IDENTITY#id-1") {
      return { Items: [
        { platform: "telegram", platform_user_id: "123", username: "someone" },
        { platform: "password", platform_user_id: "sub-1", email: "someone@example.com" },
      ] };
    }
    return {};
  });
  return lookups;
}

async function links(): Promise<readonly Link[]> {
  const body = JSON.parse((await identities(owner)).body as string) as { identities: readonly { links: readonly Link[] }[] };
  const first = body.identities[0];
  assert.ok(first, "the listing must carry the one active identity");
  return first.links;
}

const verifiedCredential = {
  subject: "sub-1", email: "someone@example.com", password_hash: "hash", email_verified: true,
};

test("a confirmed address is listed as verified", async (t) => {
  const lookups = storage(t, verifiedCredential);
  const found = await links();
  assert.equal(found.find((link) => link.platform === "password")?.verified, true);
  assert.deepEqual(lookups, ["CREDENTIAL#EMAIL#someone@example.com"]);
});

test("an unconfirmed address is listed as unverified, and so is one with no credential at all", async (t) => {
  storage(t, { ...verifiedCredential, email_verified: false });
  assert.equal((await links()).find((link) => link.platform === "password")?.verified, false);

  t.mock.restoreAll();
  storage(t, undefined);
  assert.equal((await links()).find((link) => link.platform === "password")?.verified, false);
});

test("an account from a provider that vouches for itself needs no lookup", async (t) => {
  storage(t, verifiedCredential);
  assert.equal((await links()).find((link) => link.platform === "telegram")?.verified, true);
});

test("each listed identity says whether the caller may delete it, by the owner guard", async (t) => {
  t.mock.method(document, "send", async (command: unknown) => {
    const values = (command as { input: { ExpressionAttributeValues?: Record<string, string> } }).input.ExpressionAttributeValues;
    return values?.[":state"] === "IDENTITY#ACTIVE"
      ? { Items: [
        { identity_id: "owner-1", display_name: "Owner", role_id: "owner" },
        { identity_id: "owner-2", display_name: "Second owner", role_id: "owner" },
        { identity_id: "manager-1", display_name: "Manager", role_id: "operator" },
        { identity_id: "player-1", display_name: "Player", role_id: "player" },
      ] }
      : { Items: [] };
  });
  const listing = async (caller: Parameters<typeof identities>[0]) => Object.fromEntries(
    (JSON.parse((await identities(caller)).body as string) as { identities: readonly { id: string; canDelete: boolean }[] })
      .identities.map((identity) => [identity.id, identity.canDelete]),
  );
  assert.deepEqual(await listing(owner), { "owner-1": false, "owner-2": true, "manager-1": true, "player-1": true });
  const manager = { id: "manager-1", displayName: "Manager", roleId: "operator", directGrants: ["access.manage"] } as const;
  assert.deepEqual(await listing(manager), { "owner-1": false, "owner-2": false, "manager-1": false, "player-1": true });
});
