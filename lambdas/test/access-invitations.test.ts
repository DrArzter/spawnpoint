import assert from "node:assert/strict";
import test from "node:test";

import {
  accessInvitationLifetimeSeconds,
  accessInvitationTokenHash,
  accessInvitationUrl,
  accessInvitationUsable,
  issueAccessInvitation,
  renderAccessInvitationEmail,
  renderAccessInvitationProofEmail,
} from "../src/access/access-invitations.ts";

test("access invitations are random bearer tokens stored only as hashes", () => {
  const first = issueAccessInvitation(1000);
  const second = issueAccessInvitation(1000);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.token, first.tokenHash);
  assert.equal(accessInvitationTokenHash(first.token), first.tokenHash);
  assert.equal(first.expiresAtEpochSeconds, 1000 + accessInvitationLifetimeSeconds);
  assert.equal(accessInvitationTokenHash("wrong"), null);
  assert.equal(accessInvitationTokenHash({ token: first.token }), null);
});

test("invitation URLs use the panel hash route and are not tied to an email or provider", () => {
  const invitation = issueAccessInvitation(1000);
  assert.equal(accessInvitationUrl("https://spawnpoint.example.test/", invitation.token), `https://spawnpoint.example.test/#/join?token=${invitation.token}`);
});

test("only a pending unexpired invitation can be consumed", () => {
  const item = { entity_type: "ACCESS_INVITATION", status: "PENDING", expires_at: 2000 };
  assert.equal(accessInvitationUsable(item, 1999), true);
  assert.equal(accessInvitationUsable(item, 2000), false);
  assert.equal(accessInvitationUsable({ ...item, status: "USED" }, 1999), false);
  assert.equal(accessInvitationUsable({ ...item, status: "REVOKED" }, 1999), false);
});

test("invitation mail names the invited address without choosing its login provider", () => {
  const invitation = issueAccessInvitation(1000);
  const url = accessInvitationUrl("https://spawnpoint.example.test/", invitation.token);
  const message = renderAccessInvitationEmail({ email: "ada@example.test", inviterName: "Owner <Admin>", url, tokenHash: invitation.tokenHash });
  assert.equal(message.to, "ada@example.test");
  assert.match(message.text, /choose how you want to sign in/);
  assert.match(message.html, /Owner &lt;Admin&gt;/);
  assert.doesNotMatch(message.html, /Owner <Admin>/);
  assert.equal(message.idempotencyKey, `access-invitation/${invitation.tokenHash}`);
});

test("mailbox proof is addressed to the invited email and carries a separate token", () => {
  const message = renderAccessInvitationProofEmail({
    email: "ada@example.test",
    url: "https://spawnpoint.example.test/#/join?token=invite&proof=proof",
    proofHash: "proof-hash",
  });
  assert.equal(message.to, "ada@example.test");
  assert.match(message.text, /proof=proof/);
  assert.match(message.html, /&amp;proof=proof/);
  assert.equal(message.idempotencyKey, "access-invitation-proof/proof-hash");
});
