import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionOverview, buildWorldRow, sessionControlAvailability } from "../src/core/worlds.ts";
import { deriveServerState } from "../src/core/useConsole.ts";
import type { ControlPlaneSnapshot, Game, World, WorldSession } from "../src/model.ts";
import { deriveSharedHostSession, fleetSessionOf, fleetWorldState, operationsBlockingWorld, worldSessionActive } from "../src/session.ts";

// ADR-0062: two fleet worlds of one game run at once, each on a host launched
// for it and a session record of its own. Neither refuses the other.

function session(worldId: string, observedState: WorldSession["observedState"], players: number | null = null): WorldSession {
  const active = observedState !== "stopped";
  return {
    serverId: `world#${worldId}`,
    desiredState: active && observedState !== "stopping" ? "running" : "stopped",
    observedState,
    activeSessionId: active ? `session-${worldId}` : null,
    activeWorldId: active ? worldId : null,
    updatedAtEpochSeconds: 1,
    idle: players === null ? null : { playersOnline: players, consecutiveEmpty: 0, lastObservedAtEpochSeconds: 1 },
  };
}

function fleetWorld(id: string, displayName: string, worldSession: WorldSession | null): World {
  return {
    id, displayName, profileId: id, sessionControlAvailable: true, connectivity: "route53", placement: "fleet", auth: "game",
    materialization: "existing", worldLifecycleAvailable: true, wipes: [], preset: null, connectionAddress: null,
    release: { state: "available", generationId: null, desiredRelease: "1.2", activeRelease: "1.2" },
    session: worldSession,
  };
}

const rostik = fleetWorld("rostik", "Rostik", session("rostik", "ready", 3));
const magic = fleetWorld("magic", "Magic", session("magic", "ready", 2));
const spare = fleetWorld("spare", "Spare", null);
const game: Game = { id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [], worlds: [rostik, magic, spare] };

function snapshot(operations: ControlPlaneSnapshot["operations"] = []): ControlPlaneSnapshot {
  return {
    observedAt: "2026-10-09T00:00:00.000Z",
    games: [game],
    hosts: [],
    operations,
    deployment: { placement: "fleet", launchEnabled: true, dnsAvailable: true },
  };
}

test("each fleet world reads its own session; a world that has none is stopped", () => {
  assert.equal(fleetSessionOf(game, rostik)?.serverId, "world#rostik");
  assert.equal(fleetWorldState(game, rostik), "running");
  assert.equal(fleetWorldState(game, spare), "stopped");
  assert.equal(deriveServerState(game, snapshot()), "running", "the game is online while any of its worlds is");
});

test("one running world of a game never refuses another; each stops on its own", () => {
  const shared = deriveSharedHostSession(snapshot());
  const start = sessionControlAvailability(spare, game, shared, true, false, true, operationsBlockingWorld(snapshot(), spare));
  assert.equal(start.action, "start");
  assert.equal(start.disabled, false, start.hint);
  const stop = sessionControlAvailability(rostik, game, shared, true, false, true, operationsBlockingWorld(snapshot(), rostik));
  assert.equal(stop.action, "stop");
  assert.equal(stop.disabled, false, stop.hint);
});

test("a fleet world waits only for operations that are its own or name no world", () => {
  const starting = { id: "panel-start-1", type: "start" as const, status: "running" as const, startedAt: "2026-10-09T00:00:00.000Z", worldId: "magic" };
  assert.deepEqual(operationsBlockingWorld(snapshot([starting]), spare), []);
  assert.equal(operationsBlockingWorld(snapshot([starting]), magic).length, 1);
  const unnamed = { ...starting, id: "promote-1", type: "promote" as const, worldId: null };
  assert.equal(operationsBlockingWorld(snapshot([unnamed]), spare).length, 1, "an operation that names no world holds every world back");
  const refused = sessionControlAvailability(magic, game, deriveSharedHostSession(snapshot([starting])), true, false, true, operationsBlockingWorld(snapshot([starting]), magic));
  assert.equal(refused.disabled, true);
  assert.equal(deriveSharedHostSession(snapshot([starting])).operationRunning, false, "a fleet start never makes the configured host look busy");
});

test("rows tell each world's own state, and the overview says how many run", () => {
  const starting = fleetWorld("spare", "Spare", session("spare", "starting"));
  const busyGame: Game = { ...game, worlds: [rostik, magic, starting] };
  const shared = deriveSharedHostSession(snapshot());
  const row = (world: World) => buildWorldRow(busyGame, world, { fleet: true, sharedSession: shared, serverState: "running", granted: new Set(), pending: null, callbacks: { onWorldAction: () => undefined, onInvite: () => undefined, onDownloadPack: () => undefined } });
  assert.equal(row(rostik).status.label, "Online");
  assert.equal(row(magic).status.label, "Online");
  assert.equal(row(starting).status.label, "Starting");
  const overview = buildSessionOverview(game, snapshot(), "running", shared, true);
  assert.equal(overview.headline, "2 worlds online");
  assert.equal(overview.players, 5);
  assert.match(overview.reason.text, /2 worlds are running, each on a fleet host of its own/);
});

test("a world's hosting waits only for its own session", () => {
  assert.equal(worldSessionActive(game, spare), false, "another world of the game running does not hold it");
  assert.equal(worldSessionActive(game, rostik), true);
});

test("an older response with no per-world sessions still finds a fleet session on the game's record", () => {
  const legacyWorld: World = { ...spare, session: undefined };
  const legacy: Game = {
    ...game,
    worlds: [legacyWorld],
    lifecycle: { schemaVersion: 1, serverId: "minecraft", desiredState: "running", observedState: "ready", activeSessionId: "s1", activeWorldId: "spare", updatedAtEpochSeconds: 1, idle: null },
  };
  assert.equal(fleetWorldState(legacy, legacyWorld), "running");
});
