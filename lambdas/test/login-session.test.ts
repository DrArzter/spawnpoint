import assert from "node:assert/strict";
import test from "node:test";

import {
  accessTokenLifetimeSeconds,
  equalRefreshHashes,
  expiredRefreshCookie,
  issueAccessToken,
  issueRefreshCredential,
  parseRefreshCredential,
  refreshCookie,
  refreshSessionLifetimeSeconds,
  verifyAccessToken,
} from "../src/access/login-session.ts";

const principal = {
  provider: "telegram",
  subject: "1780660807",
  displayName: "DrArzter",
  username: "drarzter",
  photoUrl: "https://telegram.example/avatar.jpg",
  email: null,
};
const loginSessionId = "11111111-2222-4333-8444-555555555555";
const signingSecret = "test-signing-secret";
const now = 1_800_000_000;

test("access tokens are login-session scoped and expire after fifteen minutes", () => {
  const token = issueAccessToken(principal, loginSessionId, signingSecret, now);
  assert.deepEqual(verifyAccessToken(token, signingSecret, now + accessTokenLifetimeSeconds - 1), {
    loginSessionId,
    principal,
  });
  assert.equal(verifyAccessToken(token, signingSecret, now + accessTokenLifetimeSeconds), null);
  assert.equal(verifyAccessToken(`${token}x`, signingSecret, now), null);
  assert.equal(verifyAccessToken(token, "another-secret", now), null);
});

test("refresh credentials expose only a session id and a stable secret hash", () => {
  const issued = issueRefreshCredential(loginSessionId);
  const parsed = parseRefreshCredential(issued.token);
  assert.deepEqual(parsed, { loginSessionId, tokenHash: issued.tokenHash });
  assert.ok(equalRefreshHashes(issued.tokenHash, parsed!.tokenHash));
  assert.equal(parseRefreshCredential(`${issued.token}x`), null);

  const rotated = issueRefreshCredential(loginSessionId);
  assert.notEqual(rotated.token, issued.token);
  assert.ok(!equalRefreshHashes(issued.tokenHash, rotated.tokenHash));
});

test("the refresh credential is an HttpOnly thirty-day cookie", () => {
  const issued = issueRefreshCredential(loginSessionId);
  assert.equal(refreshSessionLifetimeSeconds, 30 * 24 * 60 * 60);
  assert.equal(
    refreshCookie(issued.token, "Strict"),
    `spawnpoint.refresh=${issued.token}; Path=/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
  );
  assert.equal(
    expiredRefreshCookie("Strict"),
    "spawnpoint.refresh=; Path=/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
  );
});
