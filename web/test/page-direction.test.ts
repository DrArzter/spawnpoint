import assert from "node:assert/strict";
import { test } from "node:test";

import { placeOf, traverse } from "../src/routing.ts";

// A page switch travels the way the hierarchy goes: deeper is forward, up or
// earlier on the rail is back, and the same place has no direction.

test("a list to one of its items goes forward, and back up goes back", () => {
  assert.equal(traverse("#/worlds/mc", "#/worlds/mc/rostik"), "forward", "Worlds list to a world");
  assert.equal(traverse("#/home/mc", "#/worlds/mc/rostik"), "forward", "Home to a world");
  assert.equal(traverse("#/worlds/mc/rostik", "#/worlds/mc"), "back", "a world to the list");
  assert.equal(traverse("#/worlds/mc/rostik/metrics", "#/home/mc"), "back", "a world to Home");
});

test("a deep page to a section page goes back, whichever section", () => {
  assert.equal(traverse("#/worlds/mc/rostik", "#/releases/mc"), "back");
  assert.equal(traverse("#/worlds/mc/rostik/backups", "#/access/users"), "back");
  assert.equal(traverse("#/worlds/mc/rostik", "#/profile"), "back");
});

test("two pages of one depth follow the rail's order", () => {
  assert.equal(traverse("#/home/mc", "#/worlds/mc"), "forward");
  assert.equal(traverse("#/worlds/mc", "#/releases/mc"), "forward");
  assert.equal(traverse("#/releases/mc", "#/profile"), "forward");
  assert.equal(traverse("#/profile", "#/home/mc"), "back");
  assert.equal(traverse("#/access/roles", "#/worlds/mc"), "back");
});

test("the same place, another game, has no direction", () => {
  assert.equal(traverse("#/worlds/minecraft", "#/worlds/factorio"), "none");
  assert.equal(traverse("#/worlds/minecraft/rostik", "#/worlds/factorio/megabase"), "none");
  assert.equal(traverse("#/releases/minecraft", "#/releases/factorio"), "none");
});

test("old aliases sit with the worlds, and a query does not change the place", () => {
  assert.deepEqual(placeOf("#/overview/mc"), placeOf("#/worlds/mc"));
  assert.deepEqual(placeOf("#/metrics/mc"), placeOf("#/worlds/mc"));
  assert.equal(placeOf("#/worlds/mc/rostik?x=1").depth, 1);
  assert.equal(placeOf("#/worlds").depth, 0);
  assert.equal(placeOf("#/home").section, 0);
});
