import assert from "node:assert/strict";
import test from "node:test";

import { subscribedIdentityIds, telegramChatIds } from "../src/bot/services/subscribers.ts";

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
