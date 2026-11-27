import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import type { ControlPlaneSnapshot, Game } from "../src/model.ts";
import { owesShowReload, SETTLE_EXPECT_MS, SETTLE_GIVE_UP_AFTER_MS, SETTLE_POLL_MS, SETTLE_SLOW_AFTER_MS, SETTLE_SLOW_POLL_MS, settlePollDelay, settleWanted, SHOW_RELOAD_GAP_MS, startSettlePoll, unsettled } from "../src/core/live-state.ts";
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

test("a state that never settles stops the poll after thirty minutes", async () => {
  assert.equal(settlePollDelay(SETTLE_GIVE_UP_AFTER_MS - 1), SETTLE_SLOW_POLL_MS);
  assert.equal(settlePollDelay(SETTLE_GIVE_UP_AFTER_MS), null);
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  startSettlePoll({ reload: async () => { reads += 1; }, visible: () => true });
  for (let elapsed = 0; elapsed < SETTLE_GIVE_UP_AFTER_MS; elapsed += SETTLE_POLL_MS) await after(SETTLE_POLL_MS);
  const atCap = reads;
  // 10 min at 5 s and 20 min at 15 s, give or take the one in flight at the cap.
  assert.ok(atCap >= 120 + 80 - 1 && atCap <= 120 + 80 + 1, String(atCap));
  for (let index = 0; index < 20; index += 1) await after(SETTLE_SLOW_POLL_MS);
  assert.equal(reads, atCap, "no read after the cap");
});

test("an accepted request keeps the poll until its operation is listed, at most a minute", () => {
  const settled = snapshot();
  assert.equal(settleWanted(settled, 0, 1_000), false);
  assert.equal(settleWanted(settled, 1_000 + SETTLE_EXPECT_MS, 1_000), true, "the first read after the request lists nothing yet");
  assert.equal(settleWanted(settled, 1_000 + SETTLE_EXPECT_MS, 1_000 + SETTLE_EXPECT_MS), false, "a request that never shows stops after a minute");
  const listed = snapshot({ operations: [{ id: "o", type: "start", status: "running", startedAt: "2026-11-27T00:00:00.000Z" }] });
  assert.equal(settleWanted(listed, 0, 1_000), true, "the second read lists it, and the transition keeps the poll");
});

test("an accepted request whose first read lists nothing still reads again within one delay", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const reads: ControlPlaneSnapshot[] = [snapshot(), snapshot({ operations: [{ id: "o", type: "start", status: "running", startedAt: "2026-11-27T00:00:00.000Z" }] })];
  let shown = reads[0]!;
  let index = 0;
  const expectingUntil = Date.now() + SETTLE_EXPECT_MS;
  assert.equal(settleWanted(shown, expectingUntil, Date.now()), true);
  const poll = startSettlePoll({ reload: async () => { shown = reads[Math.min(++index, 1)]!; }, visible: () => true });
  await after(SETTLE_POLL_MS);
  assert.equal(shown.operations.length, 1);
  assert.equal(deriveServerState(shown.games[0], shown), "starting");
  poll.stop();
});

test("showing the tab or coming back online reads once, unless a read began a moment ago", () => {
  assert.equal(owesShowReload(0, 10_000), true);
  assert.equal(owesShowReload(10_000, 10_000 + SHOW_RELOAD_GAP_MS - 1), false);
  assert.equal(owesShowReload(10_000, 10_000 + SHOW_RELOAD_GAP_MS), true);
});
