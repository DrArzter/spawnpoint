import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import type { ControlPlaneSnapshot, Game } from "../src/model.ts";
import { SETTLE_POLL_MS, SETTLE_SLOW_AFTER_MS, SETTLE_SLOW_POLL_MS, settlePollDelay, startSettlePoll, unsettled } from "../src/core/live-state.ts";
import { deriveServerState } from "../src/core/useConsole.ts";

afterEach(() => { mock.timers.reset(); });

const game = (observedState: "ready" | "starting" | "stopping" | "stopped" | "moving"): Game => ({
  id: "minecraft", code: "MC", displayName: "Minecraft", presets: [],
  lifecycle: { serverId: "minecraft", desiredState: "running", observedState, activeSessionId: "s1", activeWorldId: "w1", updatedAtEpochSeconds: 1 },
  worlds: [],
});
const snapshot = (overrides: Partial<ControlPlaneSnapshot> = {}): ControlPlaneSnapshot => ({
  observedAt: "2026-11-27T00:00:00.000Z", games: [game("ready")], hosts: [{ id: "h", name: "Shared host", state: "running" }], operations: [],
  deployment: { placement: "single", launchEnabled: false, dnsAvailable: false }, ...overrides,
});

async function flush() { for (let index = 0; index < 5; index += 1) await Promise.resolve(); }
async function after(ms: number) { mock.timers.tick(ms); await flush(); }

test("a snapshot is unsettled while anything in it is on its way", () => {
  assert.equal(unsettled(null), false);
  assert.equal(unsettled(snapshot()), false);
  assert.equal(unsettled(snapshot({ operations: [{ id: "o", type: "start", status: "running", startedAt: "2026-11-27T00:00:00.000Z" }] })), true);
  for (const state of ["starting", "stopping", "moving"] as const) assert.equal(unsettled(snapshot({ games: [game(state)] })), true, state);
  assert.equal(unsettled(snapshot({ games: [{ ...game("stopped"), worlds: [{ session: { observedState: "starting" } } as never] }] })), true, "a fleet world's own record");
  assert.equal(unsettled(snapshot({ hosts: [{ id: "h", name: "Shared host", state: "pending" }] })), true);
  assert.equal(unsettled(snapshot({ hosts: [{ id: "f", name: "Fleet", state: "pending", provenance: "launched" }] })), false, "a launched host is not the shared one");
  assert.equal(unsettled(snapshot({ games: [{ ...game("ready"), presets: [{ buildStatus: "building" } as never] }] })), true);
});

test("the poll reads every five seconds, then every fifteen after ten minutes", () => {
  assert.equal(settlePollDelay(0), SETTLE_POLL_MS);
  assert.equal(SETTLE_POLL_MS, 5000);
  assert.equal(settlePollDelay(SETTLE_SLOW_AFTER_MS - 1), SETTLE_POLL_MS);
  assert.equal(settlePollDelay(SETTLE_SLOW_AFTER_MS), SETTLE_SLOW_POLL_MS);
  assert.equal(SETTLE_SLOW_POLL_MS, 15_000);
});

test("a start that ends with no socket message shows as running at the next tick", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let backend = snapshot({ games: [game("starting")] });
  let shown = backend;
  const poll = startSettlePoll({ reload: async () => { shown = backend; }, visible: () => true });
  assert.equal(deriveServerState(shown.games[0], shown), "starting");
  backend = snapshot();
  await after(SETTLE_POLL_MS - 1);
  assert.equal(deriveServerState(shown.games[0], shown), "starting");
  await after(1);
  assert.equal(deriveServerState(shown.games[0], shown), "running");
  poll.stop();
});

test("a hidden tab makes no read, and showing it waits a full delay", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let visible = true;
  let reads = 0;
  const poll = startSettlePoll({ reload: async () => { reads += 1; }, visible: () => visible });
  visible = false;
  poll.hide();
  await after(SETTLE_POLL_MS * 10);
  assert.equal(reads, 0);
  visible = true;
  poll.show();
  await after(SETTLE_POLL_MS - 1);
  assert.equal(reads, 0);
  await after(1);
  assert.equal(reads, 1);
  poll.stop();
});

test("a failed reload keeps the poll going, and slows after ten minutes", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  const poll = startSettlePoll({ reload: async () => { reads += 1; throw new Error("offline"); }, visible: () => true });
  await after(SETTLE_POLL_MS);
  await after(SETTLE_POLL_MS);
  assert.equal(reads, 2);
  await after(SETTLE_SLOW_AFTER_MS);
  const before = reads;
  await after(SETTLE_SLOW_POLL_MS);
  assert.equal(reads, before + 1);
  poll.stop();
  await after(SETTLE_SLOW_POLL_MS * 4);
  assert.equal(reads, before + 1);
});
