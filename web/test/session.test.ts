import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPlaneSnapshot, Game } from "../src/model.ts";
import { deriveSharedHostSession, fleetPlayersOnline, nextReadingExpiry, playersOnline, worldOwnsSharedSession } from "../src/session.ts";

const activeGame: Game = {
  id: "minecraft",
  code: "MC",
  displayName: "Minecraft",
  lifecycle: {
    serverId: "minecraft",
    desiredState: "running",
    observedState: "ready",
    activeSessionId: "session-1",
    activeWorldId: "world-a",
    updatedAtEpochSeconds: 1,
  },
  presets: [],
  worlds: [
    { id: "world-a", displayName: "A", profileId: "a", sessionControlAvailable: true, connectivity: "zerotier", materialization: "existing", wipes: [], preset: null, connectionAddress: null, release: { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null } },
    { id: "world-b", displayName: "B", profileId: "b", sessionControlAvailable: true, connectivity: "zerotier", materialization: "existing", wipes: [], preset: null, connectionAddress: null, release: { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null } },
  ],
};

function snapshot(overrides: Partial<ControlPlaneSnapshot> = {}): ControlPlaneSnapshot {
  return {
    observedAt: "2026-09-14T00:00:00.000Z",
    games: [activeGame],
    hosts: [{ id: "host", name: "Shared host", state: "running" }],
    operations: [],
    ...overrides,
  };
}

test("the active lifecycle identifies exactly one world as the shared-host owner", () => {
  const session = deriveSharedHostSession(snapshot());
  assert.equal(session.state, "running");
  assert.equal(session.activeWorld?.id, "world-a");
  assert.equal(worldOwnsSharedSession(session, activeGame, activeGame.worlds[0]!), true);
  assert.equal(worldOwnsSharedSession(session, activeGame, activeGame.worlds[1]!), false);
});

test("a running host without a reported world fails closed", () => {
  const session = deriveSharedHostSession(snapshot({ games: [] }));
  assert.equal(session.state, "unknown");
  assert.equal(session.activeWorld, null);
});

test("an operation blocks the shared host regardless of selected game", () => {
  const session = deriveSharedHostSession(snapshot({
    operations: [{ id: "start-1", type: "start", status: "running", startedAt: "2026-09-14T00:00:00.000Z" }],
  }));
  assert.equal(session.state, "starting");
  assert.equal(session.operationRunning, true);
});

test("a stopped host with no active lifecycle is available", () => {
  const session = deriveSharedHostSession(snapshot({ games: [], hosts: [{ id: "host", name: "Shared host", state: "stopped" }] }));
  assert.equal(session.state, "stopped");
  assert.equal(session.operationRunning, false);
  assert.equal(session.recoveryPending, false);
});

test("ambiguous active lifecycle records fail closed while automatic recovery refuses to guess", () => {
  const second = { ...activeGame, id: "factorio", lifecycle: { ...activeGame.lifecycle!, serverId: "factorio" } };
  const session = deriveSharedHostSession(snapshot({
    games: [activeGame, second],
    hosts: [{ id: "host", name: "Shared host", state: "stopped" }],
  }));
  assert.equal(session.state, "unknown");
  assert.equal(session.recoveryPending, false);
});

test("a manually stopped host enters automatic recovery for its stranded stopping session", () => {
  const strandedGame: Game = {
    ...activeGame,
    lifecycle: { ...activeGame.lifecycle!, desiredState: "stopped", observedState: "stopping" },
  };
  const session = deriveSharedHostSession(snapshot({
    games: [strandedGame],
    hosts: [{ id: "host", name: "Shared host", state: "stopped" }],
  }));
  assert.equal(session.state, "stopping");
  assert.equal(session.recoveryPending, true);
  assert.equal(session.activeWorld?.id, "world-a");
});

test("a manually stopped ready session also enters automatic recovery", () => {
  const session = deriveSharedHostSession(snapshot({
    hosts: [{ id: "host", name: "Shared host", state: "stopped" }],
  }));
  assert.equal(session.state, "stopping");
  assert.equal(session.recoveryPending, true);
});

test("a player reading counts only until its time; after that the count is unknown, never the old number", () => {
  const reading = (freshUntilEpochSeconds?: number | null): Game => ({
    ...activeGame,
    lifecycle: {
      ...activeGame.lifecycle!,
      idle: { playersOnline: 1, consecutiveEmpty: 0, lastObservedAtEpochSeconds: 1_000, ...(freshUntilEpochSeconds === undefined ? {} : { freshUntilEpochSeconds }) },
    },
  });
  assert.equal(playersOnline(reading(3_100), 3_100), 1, "current up to its time");
  assert.equal(playersOnline(reading(3_100), 3_101), null, "a watchdog that stopped probing says nothing about who is online");
  const world = activeGame.worlds[0]!;
  assert.equal(fleetPlayersOnline(reading(3_100), world, 3_101), null);
  assert.equal(playersOnline(reading(null), 9_999), 1, "a failed or absent time keeps today's reading");
  assert.equal(playersOnline(reading(), 9_999), 1, "a server that predates the field keeps today's reading");
});

test("the panel knows when the next shown reading expires, across game and world sessions", () => {
  const idle = (freshUntilEpochSeconds: number) => ({ playersOnline: 1, consecutiveEmpty: 0, lastObservedAtEpochSeconds: 1, freshUntilEpochSeconds });
  const game: Game = {
    ...activeGame,
    lifecycle: { ...activeGame.lifecycle!, idle: idle(5_000) },
    worlds: [{ ...activeGame.worlds[0]!, session: { ...activeGame.lifecycle!, activeWorldId: "world-a", idle: idle(4_000) } }, activeGame.worlds[1]!],
  };
  assert.equal(nextReadingExpiry(snapshot({ games: [game] }), 3_000), 4_000);
  assert.equal(nextReadingExpiry(snapshot({ games: [game] }), 4_500), 5_000, "an expired reading needs no timer");
  assert.equal(nextReadingExpiry(snapshot({ games: [game] }), 6_000), null);
  assert.equal(nextReadingExpiry(null, 0), null);
});
