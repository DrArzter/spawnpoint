import assert from "node:assert/strict";
import test from "node:test";

import {
  controlPlaneConnectionItem,
  subscriptionConnectionLifetimeSeconds,
  subscriptionTicketItem,
  subscriptionTicketKey,
  subscriptionTicketLifetimeSeconds,
} from "../src/control-plane/subscriptions.ts";

test("subscription tickets are hashed, short-lived and identity scoped", () => {
  const ticket = "a".repeat(43);
  const item = subscriptionTicketItem(ticket, "identity-1", 1_000);
  assert.equal(item.pk, subscriptionTicketKey(ticket));
  assert.notEqual(item.pk, `TICKET#${ticket}`);
  assert.equal(item.sk, "CONTROL_PLANE");
  assert.equal(item.identity_id, "identity-1");
  assert.equal(item.expires_at, 1_000 + subscriptionTicketLifetimeSeconds);
});

test("control-plane connections share a queryable partition and expire", () => {
  assert.deepEqual(controlPlaneConnectionItem("connection-1", "identity-1", 2_000), {
    pk: "SUBSCRIPTIONS#CONTROL_PLANE",
    sk: "CONNECTION#connection-1",
    schema_version: 1,
    connection_id: "connection-1",
    identity_id: "identity-1",
    expires_at: 2_000 + subscriptionConnectionLifetimeSeconds,
  });
});
