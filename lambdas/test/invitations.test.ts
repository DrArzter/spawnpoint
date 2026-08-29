import assert from "node:assert/strict";
import test from "node:test";

import { parseInvitationEvent, renderInvitation } from "../src/domain/invitations.ts";

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

test("malformed invitations are rejected", () => {
  assert.equal(parseInvitationEvent(null), null);
  assert.equal(parseInvitationEvent({ ...direct, audience: "friends" }), null);
  assert.equal(parseInvitationEvent({ ...direct, recipientIdentityIds: [42] }), null);
  assert.equal(parseInvitationEvent({ ...direct, senderDisplayName: "" }), null);
});
