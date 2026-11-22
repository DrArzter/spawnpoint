import assert from "node:assert/strict";
import { test } from "node:test";

import { placeOf, traverse } from "../src/routing.ts";

// A page switch travels the way the hierarchy goes: deeper is forward, up or
// earlier on the rail is back, and the same place has no direction.

type Case = readonly [from: string, to: string, expected: ReturnType<typeof traverse>];

const CASES: Readonly<Record<string, readonly Case[]>> = {
  "a list to one of its items goes forward, and back up goes back": [
    ["#/worlds/mc", "#/worlds/mc/rostik", "forward"],
    ["#/home/mc", "#/worlds/mc/rostik", "forward"],
    ["#/worlds/mc/rostik", "#/worlds/mc", "back"],
    ["#/worlds/mc/rostik/metrics", "#/home/mc", "back"],
  ],
  "a deep page to a section page goes back, whichever section": [
    ["#/worlds/mc/rostik", "#/releases/mc", "back"],
    ["#/worlds/mc/rostik/backups", "#/access/users", "back"],
    ["#/worlds/mc/rostik", "#/profile", "back"],
  ],
  "two pages of one depth follow the rail's order": [
    ["#/home/mc", "#/worlds/mc", "forward"],
    ["#/worlds/mc", "#/releases/mc", "forward"],
    ["#/releases/mc", "#/profile", "forward"],
    ["#/profile", "#/home/mc", "back"],
    ["#/access/roles", "#/worlds/mc", "back"],
  ],
  "the same place, another game, has no direction": [
    ["#/worlds/minecraft", "#/worlds/factorio", "none"],
    ["#/worlds/minecraft/rostik", "#/worlds/factorio/megabase", "none"],
    ["#/releases/minecraft", "#/releases/factorio", "none"],
  ],
};

for (const [name, cases] of Object.entries(CASES)) {
  test(name, () => {
    for (const [from, to, expected] of cases) assert.equal(traverse(from, to), expected, `${from} → ${to}`);
  });
}

test("old aliases sit with the worlds, and a query does not change the place", () => {
  assert.deepEqual(placeOf("#/overview/mc"), placeOf("#/worlds/mc"));
  assert.deepEqual(placeOf("#/metrics/mc"), placeOf("#/worlds/mc"));
  assert.equal(placeOf("#/worlds/mc/rostik?x=1").depth, 1);
  assert.equal(placeOf("#/worlds").depth, 0);
  assert.equal(placeOf("#/home").section, 0);
});
