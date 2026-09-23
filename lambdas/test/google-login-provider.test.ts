import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { authenticateWith } from "../src/access/login-provider.ts";
import { createGoogleLoginProvider, GOOGLE_CLIENT_ID, googlePrincipal } from "../src/access/google-login-provider.ts";

const now = 1_800_000_000;
const clientId = "1234567890-abc123def456.apps.googleusercontent.com";

// A key pair standing in for Google's, published the way Google publishes its own.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "google-key-1", alg: "RS256", use: "sig" };
const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

function token(overrides: Record<string, unknown> = {}, kid = "google-key-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: clientId,
    sub: "110169484474386276334",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/a/photo",
    iat: now - 5,
    exp: now + 3600,
    ...overrides,
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

const provider = createGoogleLoginProvider({ clientId, nowSeconds: () => now, fetcher: fetchJwks });

test("a Google ID token for this client becomes a principal keyed by Google's stable subject", async () => {
  assert.deepEqual(await authenticateWith(provider, { idToken: token() }), {
    provider: "google",
    subject: "110169484474386276334",
    displayName: "Ada Lovelace",
    username: null,
    photoUrl: "https://lh3.googleusercontent.com/a/photo",
    email: "ada@example.com",
  });
});

test("both spellings of Google's issuer are Google; anything else is not", async () => {
  assert.ok(await provider.authenticate({ idToken: token({ iss: "accounts.google.com" }) }));
  assert.equal(await provider.authenticate({ idToken: token({ iss: "https://accounts.google.example" }) }), null);
});

test("a token for another client, an expired one, a stale one and a tampered one are all refused alike", async () => {
  assert.equal(await provider.authenticate({ idToken: token({ aud: "other.apps.googleusercontent.com" }) }), null);
  assert.equal(await provider.authenticate({ idToken: token({ exp: now - 1 }) }), null);
  // Unexpired, but minted long ago: a sign-in is a moment, not a bearer key.
  assert.equal(await provider.authenticate({ idToken: token({ iat: now - 3600 }) }), null);
  assert.equal(await provider.authenticate({ idToken: `${token()}x` }), null);
  assert.equal(await provider.authenticate({ idToken: token({}, "unknown-kid") }), null);
});

test("an unverified email is not carried, and the name falls back sensibly", () => {
  assert.equal(googlePrincipal({ sub: "42", email: "ada@example.com", email_verified: false, name: "Ada" })?.email, null);
  assert.equal(googlePrincipal({ sub: "42", email: "ada@example.com", email_verified: true })?.displayName, "ada");
  assert.equal(googlePrincipal({ sub: "42" })?.displayName, "Google user");
  assert.equal(googlePrincipal({ email: "ada@example.com", email_verified: true }), null, "no subject, no principal");
  assert.equal(googlePrincipal({ sub: "42", picture: "http://insecure.example/p" })?.photoUrl, null);
});

test("a provider with no client id, or a malformed one, verifies nothing", async () => {
  assert.equal(await createGoogleLoginProvider({ clientId: "", fetcher: fetchJwks }).authenticate({ idToken: token() }), null);
  assert.equal(await createGoogleLoginProvider({ clientId: "8521897198", fetcher: fetchJwks }).authenticate({ idToken: token({ aud: "8521897198" }) }), null);
  assert.ok(GOOGLE_CLIENT_ID.test(clientId));
  assert.ok(!GOOGLE_CLIENT_ID.test("8521897198"), "a BotFather id is not a Google one");
});
