import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPlaneSnapshot, Game } from "../src/model.ts";
import { deriveSharedHostSession, worldOwnsSharedSession } from "../src/session.ts";

const activeGame: Game = {
  id: "minecraft",
  code: "MC",
  displayName: "Minecraft",
  lifecycle: {
    schemaVersion: 1,
    serverId: "minecraft",
    desiredState: "running",
    observedState: "ready",
    activeSessionId: "session-1",
    activeWorldId: "world-a",
    updatedAtEpochSeconds: 1,
  },
  presets: [],
  worlds: [
    { id: "world-a", displayName: "A", profileId: "a", sessionControlAvailable: true, connectivity: "zerotier", materialization: "existing", worldLifecycleAvailable: true, wipes: [], preset: null, connectionAddress: null, release: { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null } },
    { id: "world-b", displayName: "B", profileId: "b", sessionControlAvailable: true, connectivity: "zerotier", materialization: "existing", worldLifecycleAvailable: true, wipes: [], preset: null, connectionAddress: null, release: { state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null } },
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
  assert.equal(session.recoveryAvailable, false);
});

test("a manually stopped host exposes recovery for its stranded stopping session", () => {
  const strandedGame: Game = {
    ...activeGame,
    lifecycle: { ...activeGame.lifecycle!, desiredState: "stopped", observedState: "stopping" },
  };
  const session = deriveSharedHostSession(snapshot({
    games: [strandedGame],
    hosts: [{ id: "host", name: "Shared host", state: "stopped" }],
  }));
  assert.equal(session.state, "stopping");
  assert.equal(session.recoveryAvailable, true);
  assert.equal(session.activeWorld?.id, "world-a");
});
