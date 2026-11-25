import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { createLoadSequence, deriveServerState, sessionAcceptedMessage } from "../src/core/useConsole.ts";
import { buildWorldRow, sessionDetails, worldSessionControl } from "../src/core/worlds.ts";
import { initialState } from "../src/demo/data.ts";
import type { ControlPlaneSnapshot, Game, Host, Operation, World, WorldSession } from "../src/model.ts";
import { configuredHosts, deriveSharedHostSession, operationsBlockingWorld, worldSessionId, worldState } from "../src/session.ts";
import { NO_PENDING, pendingFor, withoutPending, withPending, type Pending } from "../src/shell/actions.ts";

// One world's page and row tell that world's own session, never its game's or
// another world's, and a request on one world holds back only the worlds that
// share its host (ADR-0062).

function world(id: string, placement: World["placement"], worldSession?: WorldSession | null): World {
  return {
    id, displayName: id.toUpperCase(), profileId: id, sessionControlAvailable: true, connectivity: "route53", placement, auth: "game",
    materialization: "existing", wipes: [], preset: null, connectionAddress: null,
    release: { state: "available", generationId: null, desiredRelease: "1.2", activeRelease: "1.2" },
    ...(worldSession !== undefined ? { session: worldSession } : {}),
  };
}

function session(worldId: string, observedState: WorldSession["observedState"]): WorldSession {
  const active = observedState !== "stopped";
  return {
    serverId: `world#${worldId}`, desiredState: active ? "running" : "stopped", observedState,
    activeSessionId: active ? `session-${worldId}` : null, activeWorldId: active ? worldId : null, updatedAtEpochSeconds: 1, idle: null,
  };
}

const configuredHost: Host = { id: "i-shared", name: "Shared host", state: "stopped", provenance: "configured" };
const launched = (id: string, state: Host["state"]): Host => ({ id, name: `fleet-${id}`, state, provenance: "launched" });

// Fleet deployment: fleet worlds a and c, configured worlds b and d of one game.
const fleetA = world("a", "fleet", session("a", "ready"));
const fleetC = world("c", "fleet", null);
const configuredB = world("b", "configured");
const configuredD = world("d", "configured");
const minecraft: Game = { id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [], worlds: [fleetA, configuredB, fleetC, configuredD] };
const zomboid: Game = { id: "zomboid", code: "PZ", displayName: "Project Zomboid", lifecycle: null, presets: [], worlds: [world("z", "configured")] };

function snapshot(overrides: Partial<ControlPlaneSnapshot> = {}): ControlPlaneSnapshot {
  return {
    observedAt: "2026-11-21T00:00:00.000Z",
    games: [minecraft, zomboid],
    hosts: [configuredHost, launched("a", "running")],
    operations: [],
    deployment: { placement: "fleet", launchEnabled: true, dnsAvailable: true },
    ...overrides,
  };
}

const granted = new Set(["session.start", "session.stop"]);
const callbacks = { onWorldAction: () => undefined, onInvite: () => undefined, onDownloadPack: () => undefined };
const start = (worldId: string): Operation => ({ id: `start-${worldId}`, type: "start", status: "running", startedAt: "2026-11-21T00:00:00.000Z", worldId });

function control(target: World, snap: ControlPlaneSnapshot, pending = NO_PENDING, game = minecraft) {
  return worldSessionControl(game, target, { snapshot: snap, sharedSession: deriveSharedHostSession(snap), granted, pending, busy: false });
}

test("a configured world is stopped while a fleet world of its game runs", () => {
  const shared = deriveSharedHostSession(snapshot());
  assert.equal(worldState(minecraft, fleetA, shared), "running");
  assert.equal(worldState(minecraft, configuredB, shared), "stopped");
  const details = sessionDetails(minecraft, configuredB, shared, snapshot(), worldState(minecraft, configuredB, shared), false);
  assert.deepEqual(details[0]!.value, { type: "status", status: { kind: "off", label: "Stopped" } });
  const row = buildWorldRow(minecraft, configuredB, { fleet: true, sharedSession: shared, granted, pending: NO_PENDING, callbacks });
  assert.equal(row.addressAbsent, "Assigned while online");
});

test("in the demo, Vanilla is stopped while Rostik holds the shared host", () => {
  const demo = initialState().snapshot as ControlPlaneSnapshot;
  const game = demo.games.find((item) => item.id === "minecraft")!;
  const shared = deriveSharedHostSession(demo);
  const byId = (id: string) => game.worlds.find((item) => item.id === id)!;
  assert.equal(worldState(game, byId("vanilla"), shared), "stopped");
  assert.equal(worldState(game, byId("minecraft-rostik-12345678"), shared), "running");
});

test("launched hosts are never the shared host", () => {
  assert.deepEqual(configuredHosts(snapshot()).map((host) => host.id), ["i-shared"]);
  assert.equal(deriveSharedHostSession(snapshot()).state, "stopped");
  const startB = control(configuredB, snapshot());
  assert.equal(startB.action, "start");
  assert.equal(startB.disabled, false, startB.hint);

  const provisioning = snapshot({ hosts: [configuredHost, launched("a", "running"), launched("c", "pending")] });
  assert.equal(control(configuredB, provisioning).disabled, false, "a fleet host being launched does not hold a configured world");
  assert.equal(deriveServerState(minecraft, { ...provisioning, deployment: { placement: "single", launchEnabled: false, dnsAvailable: false } }), "stopped");
});

test("an unasked stop of the configured host is still reconciled beside a launched host", () => {
  const holder: Game = {
    ...minecraft,
    lifecycle: { serverId: "minecraft", desiredState: "running", observedState: "ready", activeSessionId: "s-b", activeWorldId: "b", updatedAtEpochSeconds: 1, idle: null },
  };
  const shared = deriveSharedHostSession(snapshot({ games: [holder, zomboid] }));
  assert.equal(shared.recoveryPending, true);
  assert.equal(shared.state, "stopping");
});

test("a request on one fleet world never holds another; a configured one holds its configured siblings", () => {
  const onA = withPending(NO_PENDING, { kind: "session", worldId: "a", action: "start" });
  const c = control(fleetC, snapshot(), onA);
  assert.equal(c.disabled, false, c.hint);
  assert.equal(c.hint, "Launch or reuse a billed fleet host");

  const onB = withPending(NO_PENDING, { kind: "session", worldId: "b", action: "start" });
  assert.equal(control(configuredD, snapshot(), onB).disabled, true, "a configured sibling waits for the shared host");
  assert.equal(control(fleetC, snapshot(), onB).disabled, false, "a configured request does not hold a fleet world");
  const otherGame = control(zomboid.worlds[0]!, snapshot(), onB, zomboid);
  assert.equal(otherGame.disabled, false, otherGame.hint);
});

test("one request finishing never clears another's", () => {
  const pack: Pending = { kind: "pack", worldId: "a" };
  const build: Pending = { kind: "build", presetId: "vanilla" };
  const sessionOnA: Pending = { kind: "session", worldId: "a", action: "start" };
  let pending = withPending(withPending(NO_PENDING, pack), build);
  pending = withPending(pending, sessionOnA);
  pending = withoutPending(pending, pack);
  assert.equal(pendingFor(pending, "a"), sessionOnA, "the pack link finishing leaves the session request held");
  pending = withoutPending(pending, sessionOnA);
  assert.equal(pendingFor(pending, "a"), null);
  assert.equal(pending.build, build);
});

test("a world's page lists only the operations that hold it back", () => {
  assert.deepEqual(operationsBlockingWorld(snapshot({ operations: [start("a")] }), fleetC), []);
  assert.deepEqual(operationsBlockingWorld(snapshot({ operations: [start("b")] }), configuredD).map((item) => item.id), ["start-b"]);
});

test("the Session panel names the configured host, never a fleet host", () => {
  const shuffled = snapshot({ hosts: [launched("a", "running"), configuredHost] });
  const shared = deriveSharedHostSession(shuffled);
  const host = sessionDetails(minecraft, configuredB, shared, shuffled, "stopped", false).find((item) => item.label === "Compute host")!;
  assert.deepEqual(host.value, { type: "status", status: { kind: "off", label: "Stopped" } });
  assert.match(host.hint ?? "", /Shared host/);
});

test("another game's operation does not change this game's state", () => {
  const single = snapshot({ deployment: { placement: "single", launchEnabled: false, dnsAvailable: false }, hosts: [configuredHost], operations: [start("z")] });
  assert.equal(deriveServerState(minecraft, single), "stopped");
  assert.equal(deriveServerState(zomboid, single), "starting");
});

test("a world's session id changes when it starts, so its metrics load again", () => {
  assert.equal(worldSessionId(minecraft, fleetC), null);
  assert.equal(worldSessionId(minecraft, { ...fleetC, session: session("c", "starting") }), "session-c");
  const holder: Game = { ...minecraft, lifecycle: { serverId: "minecraft", desiredState: "running", observedState: "ready", activeSessionId: "s-b", activeWorldId: "b", updatedAtEpochSeconds: 1, idle: null } };
  assert.equal(worldSessionId(holder, configuredB), "s-b");
  assert.equal(worldSessionId(holder, configuredD), null, "a configured sibling does not hold the game's session");
});

test("a slow earlier read never overwrites a newer snapshot", () => {
  const loads = createLoadSequence();
  const older = loads.begin();
  const newer = loads.begin();
  assert.equal(loads.keep(newer), true);
  assert.equal(loads.keep(older), false);
  const later = loads.begin();
  assert.equal(loads.keep(later), true);
});

test("a fleet world's copy names the world, not a host or the fleet", () => {
  assert.equal(sessionAcceptedMessage(fleetC, "stop", "already_stopped"), "C is already stopped.");
  assert.equal(sessionAcceptedMessage(fleetA, "start", "requested"), "Start of A accepted. It appears in Operations while it runs.");
  const shared = deriveSharedHostSession(snapshot());
  const labels = sessionDetails(minecraft, fleetA, shared, snapshot(), "running", true).map((item) => item.label);
  assert.equal(labels.includes("Fleet"), false, "the fleet-wide host count is not this world's");
});
