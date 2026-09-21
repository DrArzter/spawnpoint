import assert from "node:assert/strict";
import test from "node:test";

import { invitationDeliveryStatus, parseInvitationEvent, renderInvitation, renderInvitationEmail } from "../src/domain/invitations.ts";

const direct = {
  invitationId: "inv-1",
  audience: "direct",
  gameId: "minecraft",
  gameName: "Minecraft",
  worldId: "world",
  worldName: "Main modded",
  senderIdentityId: "owner-id",
  senderDisplayName: "DrArzter",
  recipientIdentityIds: ["friend-id", "friend-id"],
};

test("a direct invitation is parsed, deduplicated and addressed personally", () => {
  const parsed = parseInvitationEvent(direct);
  assert.ok(parsed);
  assert.deepEqual(parsed.recipientIdentityIds, ["friend-id"]);
  assert.equal(renderInvitation(parsed), "[INVITE] DrArzter invited you to play Minecraft — Main modded.");
});

test("a broadcast invitation addresses everyone", () => {
  const parsed = parseInvitationEvent({ ...direct, audience: "broadcast", recipientIdentityIds: [] });
  assert.ok(parsed);
  assert.equal(renderInvitation(parsed), "[INVITE] DrArzter invited everyone to play Minecraft — Main modded.");
});

test("an invitation email is readable in text and escapes user-controlled HTML", () => {
  const message = renderInvitationEmail({
    ...direct,
    audience: "direct" as const,
    senderDisplayName: "<Owner>",
    worldName: "Factory & friends",
  }, "https://spawnpoint.example.dev/");
  assert.equal(message.subject, "<Owner> invited you to Minecraft");
  assert.match(message.text, /Open Spawnpoint: https:\/\/spawnpoint\.example\.dev\//);
  assert.match(message.html, /&lt;Owner&gt;/);
  assert.match(message.html, /Factory &amp; friends/);
  assert.doesNotMatch(message.html, /<Owner>/);
});

test("malformed invitations are rejected", () => {
  assert.equal(parseInvitationEvent(null), null);
  assert.equal(parseInvitationEvent({ ...direct, audience: "friends" }), null);
  assert.equal(parseInvitationEvent({ ...direct, recipientIdentityIds: [42] }), null);
  assert.equal(parseInvitationEvent({ ...direct, senderDisplayName: "" }), null);
});

test("delivery status distinguishes no audience, complete, partial and failed attempts", () => {
  assert.equal(invitationDeliveryStatus(0, 0), "NO_RECIPIENTS");
  assert.equal(invitationDeliveryStatus(2, 2), "DELIVERED");
  assert.equal(invitationDeliveryStatus(2, 1), "PARTIAL");
  assert.equal(invitationDeliveryStatus(2, 0), "FAILED");
});
