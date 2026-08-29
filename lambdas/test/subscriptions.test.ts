import assert from "node:assert/strict";
import test from "node:test";

import { defaultSubscriptions, subscriptionKeys, validateSubscriptions } from "../src/access/subscriptions.ts";

test("subscription keys follow the deployed game catalog", () => {
  assert.deepEqual(subscriptionKeys(), ["minecraft.started", "minecraft.stopped", "factorio.started", "factorio.stopped", "invitation.broadcast", "invitation.direct"]);
  assert.equal(Object.values(defaultSubscriptions()).every((value) => value === false), true);
});

test("partial subscription updates normalize to a complete safe document", () => {
  const parsed = validateSubscriptions({ "minecraft.started": true, "invitation.direct": true });
  assert.equal(parsed?.["minecraft.started"], true);
  assert.equal(parsed?.["minecraft.stopped"], false);
  assert.equal(parsed?.["invitation.direct"], true);
});

test("unknown keys and non-boolean values are rejected", () => {
  assert.equal(validateSubscriptions({ "minecraft.started": "yes" }), null);
  assert.equal(validateSubscriptions({ "project-zomboid.started": true }), null);
  assert.equal(validateSubscriptions([]), null);
});
