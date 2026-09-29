import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialHash, issueAuthorizationRequest, issueOAuthAccessToken, issueOpaqueCredential,
  normalizeScopes, pkceChallenge, verifyAuthorizationRequest, verifyOAuthAccessToken, verifyPkce,
} from "../src/access/oauth.ts";

const secret = "test-secret-that-is-long-enough";

test("authorization request is signed, expires, and cannot be changed", () => {
  const request = {
    clientId: "client-1", redirectUri: "http://127.0.0.1:17777/callback", resource: "https://api.example/mcp",
    scopes: ["spawnpoint.read"] as const, state: "opaque-state", codeChallenge: "A".repeat(43),
  };
  const token = issueAuthorizationRequest(request, secret, 100);
  assert.deepEqual(verifyAuthorizationRequest(token, secret, 101), request);
  assert.equal(verifyAuthorizationRequest(`${token.slice(0, -1)}x`, secret, 101), null);
  assert.equal(verifyAuthorizationRequest(token, secret, 401), null);
});

test("OAuth access token is bound to issuer, resource, client, scopes and expiry", () => {
  const subject = { identityId: "identity-1", clientId: "client-1", audience: "https://api.example/mcp", scopes: ["spawnpoint.read"] as const };
  const token = issueOAuthAccessToken(subject, "https://api.example", secret, 100);
  assert.deepEqual(verifyOAuthAccessToken(token, "https://api.example", subject.audience, secret, 101), subject);
  assert.equal(verifyOAuthAccessToken(token, "https://other.example", subject.audience, secret, 101), null);
  assert.equal(verifyOAuthAccessToken(token, "https://api.example", "https://api.example/other", secret, 101), null);
  assert.equal(verifyOAuthAccessToken(token, "https://api.example", subject.audience, secret, 1001), null);
});

test("PKCE accepts only an exact S256 verifier", () => {
  const verifier = "correct-horse-battery-staple-correct-horse-battery-staple";
  const challenge = pkceChallenge(verifier);
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce(`${verifier}x`, challenge), false);
  assert.equal(verifyPkce("short", challenge), false);
});

test("opaque credentials are random and stored only by digest", () => {
  const first = issueOpaqueCredential();
  const second = issueOpaqueCredential();
  assert.notEqual(first.token, second.token);
  assert.equal(credentialHash(first.token), first.hash);
  assert.equal(first.hash.includes(first.token), false);
});

test("scopes are allow-listed and de-duplicated", () => {
  assert.deepEqual(normalizeScopes("spawnpoint.read spawnpoint.read spawnpoint.operate"), ["spawnpoint.read", "spawnpoint.operate"]);
  assert.equal(normalizeScopes(""), null);
  assert.equal(normalizeScopes("spawnpoint.admin"), null);
});
