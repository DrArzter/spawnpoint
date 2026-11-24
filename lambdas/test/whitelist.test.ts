import assert from "node:assert/strict";
import test from "node:test";

import { builtInRoles } from "../src/access/domain.ts";
import { checkWhitelist, parseServerWhitelist, WHITELIST_LIMIT } from "../src/control-plane/whitelist.ts";
import { findGameModule } from "../src/control-plane/game-modules.ts";

const rules = findGameModule("minecraft")!.whitelistRules!;

// ADR-0066: a world's whitelist is a list of Minecraft names, kept on its
// record. An offline server derives each player's UUID from the exact name.

test("a whitelist is Minecraft names, each once, in the order given", () => {
  assert.deepEqual(checkWhitelist(["DrArzter", "Alex_2", "Mira"], rules), { ok: true, names: ["DrArzter", "Alex_2", "Mira"] });
  assert.deepEqual(checkWhitelist([], rules), { ok: true, names: [] }, "an empty list is a whitelist nobody passes");
  for (const name of ["ab", "seventeen_letters", "has space", "Мира", "$(reboot)", "dr-arzter"]) {
    assert.deepEqual(checkWhitelist([name], rules), { ok: false, error: "invalid_player_name", name }, name);
  }
  assert.deepEqual(checkWhitelist(["DrArzter", "drarzter"], rules), { ok: false, error: "duplicate_player_name", name: "drarzter" }, "two cases of one name are almost always one typing mistake");
  assert.deepEqual(checkWhitelist("DrArzter", rules), { ok: false, error: "invalid_whitelist" });
  assert.deepEqual(checkWhitelist(Array.from({ length: WHITELIST_LIMIT + 1 }, (_, index) => `player_${index}`), rules), { ok: false, error: "whitelist_too_long" });
});

test("operators and owners manage whitelists; players and viewers do not", () => {
  assert.ok(builtInRoles.operator.permissions.includes("whitelist.manage"));
  assert.ok(builtInRoles.owner.permissions.includes("whitelist.manage"));
  assert.ok(!builtInRoles.player.permissions.includes("whitelist.manage"));
  assert.ok(!builtInRoles.viewer.permissions.includes("whitelist.manage"));
});

test("a Minecraft whitelist reply gives its names, in any wording the server version uses", () => {
  assert.deepEqual(parseServerWhitelist("There are 3 whitelisted players: DrArzter, Alex_2, Mira", rules), ["DrArzter", "Alex_2", "Mira"]);
  assert.deepEqual(parseServerWhitelist("There are 2 whitelisted player(s): DrArzter, Mira\n", rules), ["DrArzter", "Mira"]);
  assert.deepEqual(parseServerWhitelist("There are 1 whitelisted players: Mira", rules), ["Mira"]);
  assert.deepEqual(parseServerWhitelist("There are no whitelisted players", rules), []);
  assert.deepEqual(parseServerWhitelist("\u001b[0mThere are 1 whitelisted players: Mira\u001b[0m", rules), ["Mira"], "terminal colours are dropped");
});

test("a reply that cannot be trusted gives no names, so a partial list is never saved over the server's", () => {
  for (const reply of ["", "Unknown command", "There are 3 whitelisted players: DrArzter, Mira", "There are 2 whitelisted players: Mira, mira", "There are 1 whitelisted players: not a name"]) {
    assert.equal(parseServerWhitelist(reply, rules), null, reply);
  }
});
