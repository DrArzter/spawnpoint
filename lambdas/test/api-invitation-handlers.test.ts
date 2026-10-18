import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { issueAccessInvitation } from "../src/access/access-invitations.ts";
import { issueEmailAction } from "../src/access/email-actions.ts";
import { type LoginPrincipal } from "../src/access/login-session.ts";

process.env.ACCESS_TABLE_NAME = "access-api-test";
const { document } = await import("../src/handlers/api/access-store.ts");
const { redeemAccessInvitation } = await import("../src/handlers/api/access-invitations.ts");

const account: LoginPrincipal = { provider: "telegram", subject: "123", displayName: "Test", username: null, email: null, photoUrl: null };
const invitation = issueAccessInvitation();
const proof = issueEmailAction("verify_email");

function storage(t: TestContext, email: string | undefined, proofItem: Record<string, unknown> = {}) {
  const transactions: Record<string, unknown>[][] = [];
  t.mock.method(document, "send", async (command: unknown) => {
    const input = (command as { input: { Key?: { pk: string; sk: string }; TransactItems?: Record<string, unknown>[] } }).input;
    if (input.TransactItems) { transactions.push(input.TransactItems); return {}; }
    if (input.Key?.sk === "TOKEN") return { Item: {
      entity_type: "ACCESS_INVITATION", status: "PENDING", expires_at: invitation.expiresAtEpochSeconds,
      created_by: "owner", ...(email === undefined ? {} : { delivery_email: email }),
    } };
    if (input.Key?.sk.startsWith("PROOF#")) return { Item: proofItem };
    return {};
  });
  return transactions;
}

test("unbound invitations join without consuming a mailbox proof", async (t) => {
  const transactions = storage(t, undefined);
  const result = await redeemAccessInvitation(account, { body: JSON.stringify({ token: invitation.token, proof: proof.token }) });
  assert.equal(result.statusCode, 201);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]?.length, 4);
});

test("password invitations require the exact invited verified account email", async (t) => {
  const transactions = storage(t, "invited@example.test");
  const wrong = await redeemAccessInvitation({ ...account, provider: "password", email: "other@example.test" }, { body: JSON.stringify({ token: invitation.token }) });
  assert.deepEqual(JSON.parse(wrong.body), { error: "invited_email_mismatch" });
  assert.equal(transactions.length, 0);
  const accepted = await redeemAccessInvitation({ ...account, provider: "password", email: "invited@example.test" }, { body: JSON.stringify({ token: invitation.token }) });
  assert.equal(accepted.statusCode, 201);
  assert.equal(transactions[0]?.length, 4);
});

test("provider logins cannot redeem email-bound invitations without a valid, unexpired proof", async (t) => {
  const transactions = storage(t, "invited@example.test", { proof_hash: proof.tokenHash, status: "PENDING", expires_at: 0 });
  const missing = await redeemAccessInvitation(account, { body: JSON.stringify({ token: invitation.token }) });
  assert.deepEqual(JSON.parse(missing.body), { error: "invited_email_verification_required" });
  const expired = await redeemAccessInvitation(account, { body: JSON.stringify({ token: invitation.token, proof: proof.token }) });
  assert.deepEqual(JSON.parse(expired.body), { error: "invalid_or_expired_invitation_proof" });
  assert.equal(transactions.length, 0);
});

test("provider mailbox proof is consumed atomically with invitation and identity writes", async (t) => {
  const transactions = storage(t, "invited@example.test", { proof_hash: proof.tokenHash, status: "PENDING", expires_at: proof.expiresAtEpochSeconds });
  assert.equal((await redeemAccessInvitation(account, { body: JSON.stringify({ token: invitation.token, proof: proof.token }) })).statusCode, 201);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]?.length, 5);
  const consume = transactions[0]?.[1] as { Update: { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> } };
  assert.equal(consume.Update.ExpressionAttributeValues[":proofHash"], proof.tokenHash);
  assert.match(consume.Update.ConditionExpression, /proof_hash = :proofHash AND expires_at > :nowEpoch/);
});
