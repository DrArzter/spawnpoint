import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionOverview, buildWorldRow, sessionControlAvailability, sessionDetails, siblingRow, worldDetails, worldLaunchedAt } from "../src/core/worlds.ts";
import { deriveServerState } from "../src/core/useConsole.ts";
import type { ControlPlaneSnapshot, Game, World, WorldSession } from "../src/model.ts";
import { deriveSharedHostSession, fleetSessionOf, fleetWorldState, operationsBlockingWorld, worldSessionActive } from "../src/session.ts";
import { NO_PENDING } from "../src/shell/actions.ts";

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
    materialization: "existing", wipes: [], preset: null, connectionAddress: null,
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
    // Production shape: the configured host stopped, each running fleet world on a host launched for it.
    hosts: [
      { id: "i-shared", name: "Shared host", state: "stopped", provenance: "configured" },
      { id: "i-rostik", name: "fleet-rostik", state: "running", provenance: "launched" },
      { id: "i-magic", name: "fleet-magic", state: "running", provenance: "launched" },
    ],
    operations,
    deployment: { placement: "fleet", launchEnabled: true, dnsAvailable: true },
  };
}

test("each fleet world reads its own session; a world that has none is stopped", () => {
  assert.equal(fleetSessionOf(rostik)?.serverId, "world#rostik");
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
  assert.equal(deriveSharedHostSession(snapshot()).state, "stopped", "running launched hosts never make the configured host look busy");
});

test("rows tell each world's own state, and the overview says how many run", () => {
  const starting = fleetWorld("spare", "Spare", session("spare", "starting"));
  const busyGame: Game = { ...game, worlds: [rostik, magic, starting] };
  const shared = deriveSharedHostSession(snapshot());
  const row = (world: World) => buildWorldRow(busyGame, world, { fleet: true, sharedSession: shared, granted: new Set(), pending: NO_PENDING, callbacks: { onWorldAction: () => undefined, onInvite: () => undefined, onDownloadPack: () => undefined } });
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

test("a row and its data-only sibling carry the world's own players; no fleet host's launch is guessed", () => {
  const shared = deriveSharedHostSession(snapshot());
  const options = { fleet: true, sharedSession: shared, granted: new Set<string>(), pending: NO_PENDING, callbacks: { onWorldAction: () => undefined, onInvite: () => undefined, onDownloadPack: () => undefined }, snapshot: snapshot() };
  const row = buildWorldRow(game, rostik, options);
  assert.equal(row.players, 3);
  assert.equal(buildWorldRow(game, spare, options).players, null);
  assert.equal(row.launchedAt, null, "a session record with no ready time tells no uptime");
  const sibling = siblingRow(row);
  assert.deepEqual({ id: sibling.id, players: sibling.players, placement: sibling.placement }, { id: "rostik", players: 3, placement: "fleet" });
  assert.equal(Object.values(sibling).some((value) => typeof value === "object" && value !== null && "run" in value), false, "a sibling carries no action");
});

test("uptime starts at the session's ready time: a fleet world's own, a configured world's too, else the shared host's launch", () => {
  const shared = deriveSharedHostSession(snapshot());
  const readyAt = Date.UTC(2026, 9, 8, 21, 30) / 1000;
  const running = fleetWorld("rostik", "Rostik", { ...session("rostik", "ready", 3), readyAtEpochSeconds: readyAt });
  const fleet: Game = { ...game, worlds: [running, spare] };
  assert.equal(worldLaunchedAt(fleet, running, shared, snapshot()), "2026-10-08T21:30:00.000Z");
  assert.equal(worldLaunchedAt(fleet, spare, shared, snapshot()), null);
  const starting = fleetWorld("rostik", "Rostik", { ...session("rostik", "starting"), readyAtEpochSeconds: readyAt });
  assert.equal(worldLaunchedAt({ ...game, worlds: [starting] }, starting, shared, snapshot()), null, "a session that is not ready has no uptime");

  const configured: World = { ...spare, id: "vanilla", placement: "configured", session: null };
  const host = { id: "i-shared", name: "Shared host", state: "running" as const, provenance: "configured" as const, launchedAt: "2026-10-01T00:00:00.000Z" };
  const lifecycle = (extra: Partial<WorldSession>): WorldSession => ({ ...session("vanilla", "ready"), serverId: "minecraft", ...extra });
  const sharedSnapshot = { ...snapshot(), hosts: [host] };
  for (const [extra, expected] of [[{ readyAtEpochSeconds: readyAt }, "2026-10-08T21:30:00.000Z"], [{}, "2026-10-01T00:00:00.000Z"]] as const) {
    const held: Game = { ...game, worlds: [configured], lifecycle: { ...lifecycle(extra) } };
    const heldShared = deriveSharedHostSession({ ...sharedSnapshot, games: [held] });
    assert.equal(worldLaunchedAt(held, configured, heldShared, { ...sharedSnapshot, games: [held] }), expected);
  }
});

test("every session and world detail names what it is about", () => {
  const shared = deriveSharedHostSession(snapshot());
  const details = [...sessionDetails(game, rostik, shared, snapshot(), "running", true), ...worldDetails(game, rostik, "running")];
  assert.deepEqual(details.filter((detail) => detail.key === undefined).map((detail) => detail.label), []);
  assert.ok(details.some((detail) => detail.key === "players"));
});

// ADR-0102: a world whose Spot host was reclaimed is moving, never stopped or running.
test("a moving fleet world reads as moving, in progress, and refuses a session action", () => {
  const moving = fleetWorld("moving", "Moving", session("moving", "moving"));
  const withMove: Game = { ...game, worlds: [moving, spare] };
  assert.equal(fleetWorldState(withMove, moving), "moving");
  assert.equal(deriveServerState(withMove, { ...snapshot(), games: [withMove] }), "moving");
  const shared = deriveSharedHostSession(withMove, { ...snapshot(), games: [withMove] });
  const overview = buildSessionOverview(withMove, { ...snapshot(), games: [withMove] }, "moving", shared, true);
  assert.deepEqual(overview.status, { kind: "progress", label: "Moving" });
  assert.match(overview.reason.text, /Spot host was reclaimed/);
  const row = buildWorldRow(withMove, moving, { fleet: true, sharedSession: shared, granted: new Set(["session.start", "session.stop"]), pending: NO_PENDING, callbacks: {} as never });
  assert.equal(row.status.label, "Moving");
});

test("the fleet overview counts the running launched hosts on Spot", () => {
  const base = snapshot();
  const hosts = base.hosts.map((host) => host.id === "i-rostik" ? { ...host, market: "spot" as const } : host);
  const shared = deriveSharedHostSession(game, { ...base, hosts });
  assert.equal(buildSessionOverview(game, { ...base, hosts }, "running", shared, true).fleetHosts.spot, 1);
  assert.equal(buildSessionOverview(game, base, "running", shared, true).fleetHosts.spot, 0);
});

// A stop that failed leaves the world stopping (Spawnpoint.V2VerifiedStopFailed);
// the answer is to stop again, and the panel must let the person do it.
test("a fleet world stuck in stopping offers Stop again; one whose stop still runs does not", () => {
  const stuck = fleetWorld("stuck", "Stuck", session("stuck", "stopping"));
  const withStuck: Game = { ...game, worlds: [stuck, spare] };
  const shared = deriveSharedHostSession(snapshot());
  const retry = sessionControlAvailability(stuck, withStuck, shared, true, false, true, []);
  assert.equal(retry.action, "stop");
  assert.equal(retry.disabled, false, retry.hint);
  assert.match(retry.hint, /did not finish/);
  const running = { id: "panel-stop-1", type: "stop" as const, status: "running" as const, startedAt: "2026-11-27T00:00:00.000Z", worldId: "stuck" };
  const waiting = sessionControlAvailability(stuck, withStuck, shared, true, false, true, [running]);
  assert.equal(waiting.disabled, true, "a stop in progress holds the world");
});
