import assert from "node:assert/strict";
import test from "node:test";

import { parseHoldRequest } from "../src/control-plane/release-holders.ts";

const GEN = `gen-${"a".repeat(32)}`;

test("the operator tool takes game preset release world generation roles", () => {
  assert.deepEqual(parseHoldRequest(["minecraft", "industrial", "1.2", "alpha", GEN, "desired,origin"]), {
    identity: { gameId: "minecraft", presetId: "industrial" }, worldId: "alpha", generationId: GEN, release: "1.2", roles: ["desired", "origin"],
  });
  assert.equal(typeof parseHoldRequest(["minecraft", "industrial", "1.2", "alpha", "legacy", "desired"]), "object", "a pointer before generations");
});

test("the operator tool refuses a request it cannot place", () => {
  const ok = ["minecraft", "industrial", "1.2", "alpha", GEN, "desired"];
  assert.equal(typeof parseHoldRequest(ok.slice(0, 5)), "string");
  assert.equal(typeof parseHoldRequest([...ok.slice(0, 2), "latest", ...ok.slice(3)]), "string");
  assert.equal(typeof parseHoldRequest([...ok.slice(0, 4), "gen-1", "desired"]), "string");
  assert.equal(typeof parseHoldRequest([...ok.slice(0, 5), "desired,owner"]), "string");
  assert.equal(typeof parseHoldRequest(["Minecraft", ...ok.slice(1)]), "string");
});
