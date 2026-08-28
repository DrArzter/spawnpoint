import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { issueSessionToken, verifyLoginWidget, verifyMiniAppInitData, verifySessionToken } from "../src/access/telegram-auth.ts";

const botToken = "123456789:test-bot-token-kept-in-ssm";
const now = 1_800_000_000;

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

test("issues a signed, expiring Spawnpoint browser session", () => {
  const profile = verifyLoginWidget(widgetPayload(), botToken, now);
  assert.ok(profile);
  const token = issueSessionToken(profile, botToken, now);
  assert.deepEqual(verifySessionToken(token, botToken, now + 60), profile);
  assert.equal(verifySessionToken(token, botToken, now + 12 * 60 * 60 + 1), null);
  assert.equal(verifySessionToken(`${token}x`, botToken, now + 60), null);
});
