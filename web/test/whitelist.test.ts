import assert from "node:assert/strict";
import test from "node:test";

import { whitelistNameError } from "../src/core/whitelist.ts";

// ADR-0066: a name is checked before it is sent, as the API and the host check it again.

test("a whitelist name is a Minecraft name, once, in the case the player types", () => {
  assert.equal(whitelistNameError("DrArzter", ["Mira"]), null);
  for (const name of ["ab", "seventeen_letters", "has space", "Мира", "dr-arzter"]) {
    assert.match(whitelistNameError(name, []) ?? "", /3 to 16 letters/, name);
  }
  assert.equal(whitelistNameError("drarzter", ["DrArzter"]), "Already on the list.", "two cases of one name are one mistake");
});
