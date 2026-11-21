import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { readRoute, routeHash } from "../src/routing.ts";

// The game home (C+A) is the worlds page as an overview: its own address,
// read back as the worlds page, so a skin without one still draws its list.

function at(hash: string) {
  window.location.hash = hash;
  return readRoute();
}

test("#/home/<game> is the worlds page as the game's overview", () => {
  const route = at("#/home/minecraft");
  assert.equal(route.page, "worlds");
  assert.equal(route.gameId, "minecraft");
  assert.equal(route.worldId, null);
  assert.equal(route.worldsView, "overview");
  assert.equal(routeHash(route), "#/home/minecraft", "the overview writes its own address back");
});

test("every other worlds address is the list, and a world's page is never the overview", () => {
  assert.equal(at("#/worlds/minecraft").worldsView, "list");
  assert.equal(at("#/overview/minecraft").worldsView, "list");
  assert.equal(at("#/releases/minecraft").worldsView, "list");
  assert.equal(routeHash({ page: "worlds", accessTab: "users", gameId: "minecraft", worldId: null }), "#/worlds/minecraft", "a link that names no view means the list");
  assert.equal(routeHash({ page: "worlds", accessTab: "users", gameId: "minecraft", worldId: "rostik", worldsView: "overview" }), "#/worlds/minecraft/rostik", "opening a world from the overview leaves it");
  assert.equal(routeHash({ page: "worlds", accessTab: "users", gameId: null, worldId: null, worldsView: "overview" }), "#/home");
});
