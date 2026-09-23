import assert from "node:assert/strict";
import test from "node:test";

import { readAccessInvitationRoute } from "../src/routing.ts";

test("joining links preserve the invitation and optional mailbox proof", () => {
  assert.deepEqual(readAccessInvitationRoute("#/join?token=invitation"), { token: "invitation", proof: null });
  assert.deepEqual(readAccessInvitationRoute("#/join?token=invitation&proof=mailbox"), { token: "invitation", proof: "mailbox" });
  assert.equal(readAccessInvitationRoute("#/worlds"), null);
});
