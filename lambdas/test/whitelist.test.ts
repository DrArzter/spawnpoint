import assert from "node:assert/strict";
import test from "node:test";

import { builtInRoles } from "../src/access/domain.ts";
import { checkWhitelist, WHITELIST_LIMIT } from "../src/control-plane/whitelist.ts";

// ADR-0066: a world's whitelist is a list of Minecraft names, kept on its
// record. An offline server derives each player's UUID from the exact name.

test("a whitelist is Minecraft names, each once, in the order given", () => {
  assert.deepEqual(checkWhitelist(["DrArzter", "Alex_2", "Mira"]), { ok: true, names: ["DrArzter", "Alex_2", "Mira"] });
  assert.deepEqual(checkWhitelist([]), { ok: true, names: [] }, "an empty list is a whitelist nobody passes");
  for (const name of ["ab", "seventeen_letters", "has space", "Мира", "$(reboot)", "dr-arzter"]) {
    assert.deepEqual(checkWhitelist([name]), { ok: false, error: "invalid_player_name", name }, name);
  }
  assert.deepEqual(checkWhitelist(["DrArzter", "drarzter"]), { ok: false, error: "duplicate_player_name", name: "drarzter" }, "two cases of one name are almost always one typing mistake");
  assert.deepEqual(checkWhitelist("DrArzter"), { ok: false, error: "invalid_whitelist" });
  assert.deepEqual(checkWhitelist(Array.from({ length: WHITELIST_LIMIT + 1 }, (_, index) => `player_${index}`)), { ok: false, error: "whitelist_too_long" });
});

test("operators and owners manage whitelists; players and viewers do not", () => {
  assert.ok(builtInRoles.operator.permissions.includes("whitelist.manage"));
  assert.ok(builtInRoles.owner.permissions.includes("whitelist.manage"));
  assert.ok(!builtInRoles.player.permissions.includes("whitelist.manage"));
  assert.ok(!builtInRoles.viewer.permissions.includes("whitelist.manage"));
});
