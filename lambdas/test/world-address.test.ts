import assert from "node:assert/strict";
import test from "node:test";

import { worldAddress, type CatalogGame } from "../src/control-plane/catalog.ts";

// One composition for every surface — panel, bot status, bot address card —
// so the strategy's host part and the game's port cannot drift apart again.
const catalog: readonly CatalogGame[] = [{
  id: "minecraft",
  code: "MC",
  displayName: "Minecraft",
  connectPort: 25565,
  worlds: [
    { id: "overlay", displayName: "Overlay", profileId: "main", sessionControl: "v1", connectivity: "zerotier" },
    { id: "public", displayName: "Public", profileId: "main", sessionControl: "v1", connectivity: "raw" },
    { id: "named", displayName: "Named", profileId: "main", sessionControl: "v1", connectivity: "route53" },
  ],
}];

test("an overlay world's address is the configured host plus the game's port", () => {
  assert.equal(worldAddress("overlay", { connectionHost: "172.29.23.24", publicIp: "203.0.113.10" }, catalog), "172.29.23.24:25565");
  assert.equal(worldAddress("overlay", { connectionHost: "172.29.23.24", publicIp: null }, catalog), "172.29.23.24:25565", "the overlay does not depend on the instance running");
});

test("a public world's address is the instance's current one, and nothing between sessions", () => {
  assert.equal(worldAddress("public", { connectionHost: "172.29.23.24", publicIp: "203.0.113.10" }, catalog), "203.0.113.10:25565");
  assert.equal(worldAddress("public", { connectionHost: "172.29.23.24", publicIp: null }, catalog), null, "an ephemeral address is not remembered");
});

test("a DNS world has no guessed address outside an observed ready session", () => {
  assert.equal(worldAddress("named", { connectionHost: "172.29.23.24", publicIp: "203.0.113.10" }, catalog), null);
});

test("a caller who may not read an address gets none, whatever the strategy", () => {
  assert.equal(worldAddress("overlay", { connectionHost: null, publicIp: "203.0.113.10" }, catalog), null);
  assert.equal(worldAddress("public", { connectionHost: null, publicIp: "203.0.113.10" }, catalog), null);
});

test("an unknown world is an error, not a guessed port", () => {
  assert.throws(() => worldAddress("nowhere", { connectionHost: "172.29.23.24", publicIp: null }, catalog), /unknown world/);
});
