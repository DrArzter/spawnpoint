import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

process.env.ACCESS_TABLE_NAME = "access-api-test";
process.env.BOOTSTRAP_OWNER_TELEGRAM_ID = "1000";
const { document } = await import("../src/handlers/api/access-store.ts");
const { session } = await import("../src/handlers/api/session.ts");

const configuredAccount = {
  provider: "telegram", subject: "1000", displayName: "Configured", username: null, photoUrl: null, email: null,
};

const claim = { pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: "owner-1", telegram_id: "1000", claimed_at: "2026-01-01T00:00:00.000Z" };

type Table = Readonly<{ account: Record<string, unknown>; profile?: Record<string, unknown>; claims: readonly (Record<string, unknown> | undefined)[] }>;

// Answers each command from a fixed table. `claims` gives the bootstrap
// record for each successive read, so a claim can appear between two reads.
function storage(t: TestContext, table: Table) {
  const sent: string[] = [];
  let claimReads = 0;
  t.mock.method(document, "send", async (command: { constructor: { name: string }; input: { Key?: { pk: string; sk: string } } }) => {
    const name = command.constructor.name;
    sent.push(name);
    const key = command.input.Key;
    if (name === "UpdateCommand") return { Attributes: table.account };
    if (name === "TransactWriteCommand") throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
    if (key?.pk === "SYSTEM") return { Item: table.claims[Math.min(claimReads++, table.claims.length - 1)] };
    if (key?.sk === "ACCOUNT") return { Item: table.account };
    if (key?.sk === "PROFILE") return { Item: table.profile };
    return {};
  });
  return sent;
}

async function body(): Promise<Record<string, unknown>> {
  const result = await session(configuredAccount, []);
  assert.equal(result.statusCode, 200);
  return JSON.parse(result.body as string) as Record<string, unknown>;
}

test("the configured account is a visitor once the bootstrap is claimed, also when its Owner was deleted", async (t) => {
  const sent = storage(t, { account: { pk: "TELEGRAM#1000", sk: "ACCOUNT", display_name: "Configured", status: "OBSERVED" }, claims: [claim] });
  assert.equal((await body()).state, "visitor");
  assert.ok(!sent.includes("TransactWriteCommand"), "a claimed bootstrap must not be claimed again");
});

test("a claim made by another request during this one leaves the configured account a visitor", async (t) => {
  const sent = storage(t, { account: { pk: "TELEGRAM#1000", sk: "ACCOUNT", display_name: "Configured", status: "OBSERVED" }, claims: [undefined, claim] });
  assert.equal((await body()).state, "visitor");
  assert.ok(sent.includes("TransactWriteCommand"));
});

test("a failed claim on an unclaimed bootstrap is still an error", async (t) => {
  storage(t, { account: { pk: "TELEGRAM#1000", sk: "ACCOUNT", display_name: "Configured", status: "OBSERVED" }, claims: [undefined] });
  t.mock.method(console, "error", () => undefined);
  await assert.rejects(session(configuredAccount, []), { name: "TransactionCanceledException" });
});

test("a member does not receive the Owner's Telegram id from a claimed bootstrap", async (t) => {
  storage(t, {
    account: { pk: "TELEGRAM#1000", sk: "ACCOUNT", identity_id: "member-1" },
    profile: { identity_id: "member-1", display_name: "Member", role_id: "player", direct_grants: [], status: "ACTIVE" },
    claims: [claim],
  });
  const found = await body();
  assert.equal(found.state, "active");
  assert.deepEqual(found.bootstrap, { state: "claimed", ownerId: "owner-1", telegramId: null, claimedAt: claim.claimed_at });
  assert.ok(!JSON.stringify(found.bootstrap).includes(claim.telegram_id));
});
