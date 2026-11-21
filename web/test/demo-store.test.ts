import "./support/browser.ts";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as store from "../src/demo/store.ts";
import type { ControlPlaneSnapshot } from "../src/model.ts";
import { configuredHosts, deriveSharedHostSession, worldState } from "../src/session.ts";

// The demo models ADR-0062: a fleet world starts on a host launched for it and
// waits only for its own operations; configured worlds share the one configured
// host, which runs one session at a time. The store keeps one control plane per
// module, so these tests run in order against it.

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T12:00:00.000Z") });

const GAME = "minecraft";
const ROSTIK = "minecraft-rostik-12345678";
const VANILLA = "vanilla";
const CREATIVE = "minecraft-creative-5e1c9a07";

function stateOf(snapshot: ControlPlaneSnapshot, worldId: string) {
  const game = snapshot.games.find((item) => item.id === GAME)!;
  return worldState(game, game.worlds.find((item) => item.id === worldId)!, deriveSharedHostSession(snapshot));
}

let skyline = "";

test("the demo deploys fleet worlds by default and seeds one beside the configured worlds", () => {
  const snapshot = store.snapshot();
  assert.equal(snapshot.deployment?.placement, "fleet");
  assert.equal(snapshot.deployment?.launchEnabled, true);
  const worlds = snapshot.games.find((item) => item.id === GAME)!.worlds;
  assert.deepEqual(worlds.filter((item) => item.placement === "fleet").map((item) => item.id), [CREATIVE]);
  assert.deepEqual(worlds.filter((item) => item.placement === "configured").map((item) => item.id), [ROSTIK, VANILLA]);
  assert.equal(stateOf(snapshot, ROSTIK), "running");
  assert.equal(stateOf(snapshot, CREATIVE), "stopped");
});

test("two fleet worlds of a game start one after the other, each on a host of its own", () => {
  skyline = store.createWorld(GAME, "industrial", "Skyline", "1.3", "fleet", "raw").id;

  const first = store.startSession(GAME, CREATIVE);
  const second = store.startSession(GAME, skyline);

  let snapshot = store.snapshot();
  assert.deepEqual(snapshot.operations.map((operation) => [operation.id, operation.worldId]), [[first.operationId, CREATIVE], [second.operationId, skyline]]);
  const launched = snapshot.hosts.filter((host) => host.provenance === "launched");
  assert.deepEqual(launched.map((host) => [host.id, host.state]), [[`host-${CREATIVE}`, "pending"], [`host-${skyline}`, "pending"]]);
  assert.deepEqual(configuredHosts(snapshot).map((host) => [host.id, host.state]), [["host-game", "running"]]);
  assert.equal(stateOf(snapshot, CREATIVE), "starting");
  assert.equal(stateOf(snapshot, skyline), "starting");
  // The configured world keeps its session on the shared host.
  assert.equal(stateOf(snapshot, ROSTIK), "running");

  mock.timers.tick(7000);
  snapshot = store.snapshot();
  assert.deepEqual(snapshot.operations, []);
  assert.equal(stateOf(snapshot, CREATIVE), "running");
  assert.equal(stateOf(snapshot, skyline), "running");
  assert.ok(snapshot.hosts.filter((host) => host.provenance === "launched").every((host) => host.state === "running" && host.publicIp));
  assert.notEqual(store.worldMetrics(GAME, skyline, "6h"), null);
  assert.throws(() => store.startSession(GAME, CREATIVE), /already running/);
});

test("a fleet world waits only for its own operation", () => {
  store.stopSession(GAME, CREATIVE);
  assert.throws(() => store.startSession(GAME, CREATIVE), /already running/);
  assert.throws(() => store.worldLifecycle(GAME, CREATIVE, "archive"), /Another control-plane operation/);
  // Another fleet world and the configured worlds are not held back by it.
  assert.doesNotThrow(() => store.updateWhitelist(GAME, skyline, ["Steve"]));

  mock.timers.tick(6000);
  const snapshot = store.snapshot();
  assert.equal(stateOf(snapshot, CREATIVE), "stopped");
  assert.deepEqual(snapshot.hosts.map((host) => host.id), ["host-game", `host-${skyline}`]);
  assert.equal(store.worldMetrics(GAME, CREATIVE, "6h"), null);
});

test("a configured sibling is refused while another configured world of the game runs", () => {
  assert.throws(() => store.startSession(GAME, VANILLA), /The shared host already runs Minecraft/);

  store.stopSession(GAME, ROSTIK);
  // The configured world's stop holds its configured siblings, not fleet worlds.
  assert.throws(() => store.startSession(GAME, VANILLA), /Another control-plane operation/);
  assert.doesNotThrow(() => store.startSession(GAME, CREATIVE));

  mock.timers.tick(7000);
  const snapshot = store.snapshot();
  assert.equal(stateOf(snapshot, ROSTIK), "stopped");
  assert.equal(stateOf(snapshot, CREATIVE), "running");
  assert.equal(configuredHosts(snapshot)[0]?.state, "stopped");
  // With the configured host free, the sibling starts there.
  assert.doesNotThrow(() => store.startSession(GAME, VANILLA));
});
