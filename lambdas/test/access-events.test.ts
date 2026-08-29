import assert from "node:assert/strict";
import test from "node:test";

import { parseAccessApprovedEvent, privateTelegramChatId, renderAccessApproved } from "../src/domain/access-events.ts";

test("an access approval targets one private Telegram chat", () => {
  const event = parseAccessApprovedEvent({
    telegramChatId: "1780660807",
    identityId: "identity-1",
    displayName: "Alex",
    roleName: "Player",
  });
  assert.ok(event);
  assert.equal(event.telegramChatId, 1780660807);
  assert.match(renderAccessApproved(event), /approved with the Player role/);
  assert.match(renderAccessApproved(event), /choose your notification subscriptions/);
});

test("group, missing and malformed approval targets are rejected", () => {
  assert.equal(privateTelegramChatId(-100123), null);
  assert.equal(privateTelegramChatId("not-a-chat"), null);
  assert.equal(parseAccessApprovedEvent({ telegramChatId: -100123, identityId: "id", displayName: "Alex", roleName: "Player" }), null);
  assert.equal(parseAccessApprovedEvent({ telegramChatId: 123, identityId: "id", displayName: "", roleName: "Player" }), null);
});
