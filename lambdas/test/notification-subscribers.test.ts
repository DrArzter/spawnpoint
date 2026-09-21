import assert from "node:assert/strict";
import test from "node:test";

import { subscribedIdentityIds, telegramChatIds, verifiedEmailAddresses } from "../src/bot/services/subscribers.ts";

test("subscription records select unique enabled identities", () => {
  assert.deepEqual(subscribedIdentityIds([
    { pk: "IDENTITY#alice", sk: "SUBSCRIPTIONS", subscriptions: { "minecraft.started": true } },
    { pk: "IDENTITY#bob", sk: "SUBSCRIPTIONS", subscriptions: { "minecraft.started": false } },
    { pk: "IDENTITY#alice", sk: "SUBSCRIPTIONS", subscriptions: { "minecraft.started": true } },
    { pk: "IDENTITY#ignored", sk: "PROFILE", subscriptions: { "minecraft.started": true } },
  ], "minecraft.started"), ["alice"]);
});

test("only valid private Telegram chats become personal targets", () => {
  assert.deepEqual(telegramChatIds([
    { platform: "telegram", chat_id: "123" },
    { platform: "telegram", chat_id: 456 },
    { platform: "telegram", chat_id: "-456", direct_chat_id: "789" },
    { platform: "telegram", chat_id: "123" },
    { platform: "telegram", chat_id: "-789" },
    { platform: "discord", chat_id: "777" },
    { platform: "telegram", chat_id: "not-a-number" },
  ]), [123, 456, 789]);
});

test("only a verified credential matching its linked password account becomes an email target", () => {
  assert.deepEqual(verifiedEmailAddresses([
    { platform: "password", platform_user_id: "subject-1", email: "one@example.com" },
    { platform: "password", platform_user_id: "subject-2", email: "two@example.com" },
    { platform: "password", platform_user_id: "subject-3", email: "claimed@example.com" },
    { platform: "telegram", platform_user_id: "subject-4", email: "telegram@example.com" },
  ], [
    { entity_type: "PASSWORD_CREDENTIAL", subject: "subject-1", email: "one@example.com", email_verified: true },
    { entity_type: "PASSWORD_CREDENTIAL", subject: "subject-2", email: "two@example.com", email_verified: false },
    { entity_type: "PASSWORD_CREDENTIAL", subject: "subject-3", email: "real@example.com", email_verified: true },
    { entity_type: "PASSWORD_CREDENTIAL", subject: "subject-4", email: "telegram@example.com", email_verified: true },
  ]), ["one@example.com"]);
});
