import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { issueSessionToken, legacySessionLifetimeSeconds, verifyLoginWidget, verifyMiniAppInitData, verifyOidcIdToken, verifySessionToken } from "../src/access/telegram-auth.ts";

const botToken = "123456789:test-bot-token-kept-in-ssm";
const now = 1_800_000_000;
const oidcClientId = "8521897198";

function widgetPayload(overrides: Record<string, string> = {}): Record<string, string> {
  const values = {
    id: "1780660807",
    first_name: "DrArzter",
    username: "drarzter",
    auth_date: String(now),
    ...overrides,
  };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  return { ...values, hash: createHmac("sha256", secret).update(check).digest("hex") };
}

function miniAppInitData(includeTelegramSignature = false): string {
  const params = new URLSearchParams({
    auth_date: String(now),
    query_id: "AAEAA-test",
    user: JSON.stringify({ id: 1780660807, first_name: "DrArzter", username: "drarzter" }),
  });
  if (includeTelegramSignature) {
    params.set("signature", "telegram-third-party-ed25519-signature");
  }
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("verifies a fresh Telegram Login Widget payload", () => {
  assert.deepEqual(verifyLoginWidget(widgetPayload(), botToken, now), {
    telegramId: "1780660807",
    displayName: "DrArzter",
    username: "drarzter",
    photoUrl: null,
  });
  assert.equal(verifyLoginWidget(widgetPayload({ auth_date: String(now - 601) }), botToken, now), null);
  assert.equal(verifyLoginWidget({ ...widgetPayload(), username: "attacker" }, botToken, now), null);
});

test("verifies Telegram Mini App initData with the WebAppData key derivation", () => {
  assert.equal(verifyMiniAppInitData(miniAppInitData(), botToken, now)?.telegramId, "1780660807");
  assert.equal(verifyMiniAppInitData(miniAppInitData(true), botToken, now)?.telegramId, "1780660807");
  assert.equal(verifyMiniAppInitData(`${miniAppInitData()}x`, botToken, now), null);
});

test("verifies a Telegram OIDC ID token against JWKS and its claims", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "telegram-test-key";
  const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const token = (overrides: Record<string, unknown> = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: "https://oauth.telegram.org",
      aud: oidcClientId,
      sub: "telegram:1780660807",
      id: 1780660807,
      name: "DrArzter",
      preferred_username: "drarzter",
      picture: "https://telegram.example/avatar.jpg",
      iat: now,
      exp: now + 3600,
      ...overrides,
    })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
    return `${header}.${claims}.${signature}`;
  };
  const fetchJwks = async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) });

  assert.deepEqual(await verifyOidcIdToken(token(), oidcClientId, now, fetchJwks), {
    telegramId: "1780660807",
    displayName: "DrArzter",
    username: "drarzter",
    photoUrl: "https://telegram.example/avatar.jpg",
  });
  assert.equal(await verifyOidcIdToken(token({ aud: "another-client" }), oidcClientId, now, fetchJwks), null);
  assert.equal(await verifyOidcIdToken(token({ iss: "https://attacker.example" }), oidcClientId, now, fetchJwks), null);
  assert.equal(await verifyOidcIdToken(token({ exp: now - 1 }), oidcClientId, now, fetchJwks), null);
  assert.equal(await verifyOidcIdToken(`${token()}x`, oidcClientId, now, fetchJwks), null);
});

test("issues a signed, expiring Spawnpoint browser session", () => {
  const profile = verifyLoginWidget(widgetPayload(), botToken, now);
  assert.ok(profile);
  const token = issueSessionToken(profile, botToken, now);
  assert.deepEqual(verifySessionToken(token, botToken, now + 60), profile);
  assert.deepEqual(verifySessionToken(token, botToken, now + legacySessionLifetimeSeconds - 1), profile);
  assert.equal(verifySessionToken(token, botToken, now + legacySessionLifetimeSeconds), null);
  assert.equal(verifySessionToken(`${token}x`, botToken, now + 60), null);
});
