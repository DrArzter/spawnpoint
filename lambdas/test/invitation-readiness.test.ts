import assert from "node:assert/strict";
import test from "node:test";

import { directInvitationReadiness } from "../src/access/invitation-readiness.ts";

test("direct invitations require an explicit subscription", () => {
  assert.equal(directInvitationReadiness(undefined, [{ platform: "telegram", direct_chat_id: 123 }]), "notifications_off");
  assert.equal(directInvitationReadiness({ subscriptions: { "invitation.direct": false } }, [{ platform: "telegram", direct_chat_id: 123 }]), "notifications_off");
});

test("direct invitations require a reachable private Telegram chat", () => {
  const enabled = { subscriptions: { "invitation.direct": true } };
  assert.equal(directInvitationReadiness(enabled, []), "bot_unavailable");
  assert.equal(directInvitationReadiness(enabled, [{ platform: "telegram", chat_id: -100123 }]), "bot_unavailable");
  assert.equal(directInvitationReadiness(enabled, [{ platform: "discord", direct_chat_id: 123 }]), "bot_unavailable");
});

test("a subscribed identity with a private Telegram chat is ready", () => {
  const enabled = { subscriptions: { "invitation.direct": true } };
  assert.equal(directInvitationReadiness(enabled, [{ platform: "telegram", direct_chat_id: "123" }]), "ready");
  assert.equal(directInvitationReadiness(enabled, [{ platform: "telegram", chat_id: 456 }]), "ready");
});
