import assert from "node:assert/strict";
import test from "node:test";

import {
  emailActionTokenHash,
  emailVerificationLifetimeSeconds,
  issueEmailAction,
  passwordResetLifetimeSeconds,
  renderEmailAction,
} from "../src/access/email-actions.ts";

test("email action tokens are opaque, hashed and bounded by purpose", () => {
  const verification = issueEmailAction("verify_email", 1_800_000_000);
  const reset = issueEmailAction("reset_password", 1_800_000_000);
  assert.match(verification.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(emailActionTokenHash(verification.token), verification.tokenHash);
  assert.equal(emailActionTokenHash("not a token"), null);
  assert.equal(verification.expiresAtEpochSeconds, 1_800_000_000 + emailVerificationLifetimeSeconds);
  assert.equal(reset.expiresAtEpochSeconds, 1_800_000_000 + passwordResetLifetimeSeconds);
});

test("verification mail carries the public link without trusting display text as HTML", () => {
  const action = issueEmailAction("verify_email", 1_800_000_000);
  const message = renderEmailAction("verify_email", {
    email: "ada@example.com",
    displayName: "Ada <Admin>",
    panelUrl: "https://spawnpoint.example.dev/",
    action,
  });
  assert.match(message.text, new RegExp(`https://spawnpoint\\.example\\.dev/#/verify-email\\?token=${action.token}`));
  assert.match(message.html, /Ada &lt;Admin&gt;/);
  assert.doesNotMatch(message.html, /Ada <Admin>/);
  assert.equal(message.idempotencyKey, `verify_email/${action.nonce}`);
});
