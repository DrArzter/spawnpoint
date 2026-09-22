import assert from "node:assert/strict";
import test from "node:test";

import type { HostObservation, OperationObservation } from "../src/control-plane/read-model.ts";
import { catalogWithPresets } from "../src/control-plane/catalog.ts";
import { packRelease, planFleetSessionOperation, planSessionOperation, stoppedHostRecoverySession, worldLifecycleNeedsStop } from "../src/control-plane/session-control.ts";
import type { LifecycleRecord } from "../src/domain/lifecycle.ts";
import { newWorldRecord } from "../src/control-plane/world-registry.ts";

const host = (state: HostObservation["state"]): HostObservation => ({ id: "host", name: "Host", state, providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null, publicIp: null });
const operation: OperationObservation = { id: "op", type: "start", status: "running", startedAt: "2026-08-29T00:00:00Z", providerRef: "arn:op" };

test("any world in the catalog can execute, because the machines take a world id", () => {
  const factorioPreset = {
    id: "factorio-vanilla", displayName: "Factorio vanilla", gameId: "factorio",
    repository: "https://github.com/example/factorio", commit: "1".repeat(40), profileDigest: "2".repeat(64),
    buildStatus: "ready", releases: ["1.0"], latestRelease: "1.0",
  } as const;
  const world = newWorldRecord(
    factorioPreset,
    { worldId: "factorio-factory-12345678", displayName: "Factory", release: "1.0" },
    "12345678-1234-1234-1234-1234567890ab",
    "2026-09-08T00:00:00.000Z",
  );
  const catalog = catalogWithPresets([factorioPreset], undefined, [world]);
  assert.equal(planSessionOperation("minecraft", "world", "start", [host("stopped")], []).kind, "execute");
  assert.equal(planSessionOperation("minecraft", "vanilla", "start", [host("stopped")], []).kind, "execute");
  assert.equal(planSessionOperation("factorio", world.worldId, "start", [host("stopped")], [], catalog).kind, "execute");
  assert.deepEqual(
    planSessionOperation("factorio", factorioPreset.id, "start", [host("stopped")], [], catalog),
    { kind: "reject", reason: "unknown_world" },
    "a preset itself is never executable",
  );
  assert.deepEqual(planSessionOperation("minecraft", "missing", "start", [host("stopped")], []), { kind: "reject", reason: "unknown_world" });
});

test("a world listed before its session workflow exists is refused, not attempted", () => {
  const catalog = [{ id: "later", code: "LT", displayName: "Later", connectPort: 12345, worlds: [
    { id: "later", displayName: "Later", profileId: "later", sessionControl: null, connectivity: "zerotier" as const },
  ] }];
  assert.deepEqual(
    planSessionOperation("later", "later", "start", [host("stopped")], [], catalog),
    { kind: "reject", reason: "unsupported_world" },
  );
});

test("a running host refuses a start, because its state does not say which world is up", () => {
  assert.deepEqual(
    planSessionOperation("minecraft", "world", "start", [host("running")], []),
    { kind: "reject", reason: "host_already_running" },
  );
  // Stopping the world that is up stays possible; that is how the host frees.
  assert.equal(planSessionOperation("minecraft", "world", "stop", [host("running")], []).kind, "execute");
});

test("global operations and ambiguous hosts fail closed", () => {
  assert.deepEqual(planSessionOperation("minecraft", "world", "start", [host("stopped")], [operation]), { kind: "reject", reason: "operation_in_progress" });
  assert.deepEqual(planSessionOperation("minecraft", "world", "start", [], []), { kind: "reject", reason: "host_not_unique" });
  assert.deepEqual(planSessionOperation("minecraft", "world", "start", [host("stopped"), host("running")], []), { kind: "reject", reason: "host_not_unique" });
});

test("fleet sessions do not depend on a unique persistent host", () => {
  assert.equal(planFleetSessionOperation("minecraft", "world", "start", [], null).kind, "execute");
  const active: LifecycleRecord = {
    schemaVersion: 1, serverId: "minecraft", desiredState: "running", observedState: "ready",
    activeSessionId: "session-1", activeWorldId: "world", fencingToken: 1, lease: null, idle: null,
    updatedAtEpochSeconds: 1,
  };
  assert.deepEqual(planFleetSessionOperation("minecraft", "world", "start", [], active), { kind: "reject", reason: "session_transitioning" });
  assert.equal(planFleetSessionOperation("minecraft", "world", "stop", [], active).kind, "execute");
  assert.deepEqual(planFleetSessionOperation("minecraft", "world", "stop", [], { ...active, activeWorldId: "vanilla" }), { kind: "reject", reason: "world_not_active" });
  assert.deepEqual(planFleetSessionOperation("minecraft", "world", "stop", [], null), { kind: "noop", reason: "already_stopped" });
});

test("stop is idempotent and transitional host states are rejected", () => {
  assert.deepEqual(planSessionOperation("minecraft", "world", "stop", [host("stopped")], []), { kind: "noop", reason: "already_stopped" });
  assert.equal(planSessionOperation("minecraft", "world", "stop", [host("running")], []).kind, "execute");
  assert.deepEqual(planSessionOperation("minecraft", "world", "start", [host("stopping")], []), { kind: "reject", reason: "host_transitioning" });
});

test("a manually stopped host can reconcile its stranded stopping session", () => {
  const lifecycle: LifecycleRecord = {
    schemaVersion: 1, serverId: "factorio", desiredState: "stopped", observedState: "stopping",
    activeSessionId: "session-1", activeWorldId: "factory", fencingToken: 2, lease: null, idle: null,
    updatedAtEpochSeconds: 1,
  };
  assert.equal(stoppedHostRecoverySession("factory", [host("stopped")], lifecycle), "session-1");
  assert.equal(stoppedHostRecoverySession("another-world", [host("stopped")], lifecycle), null);
  assert.equal(stoppedHostRecoverySession("factory", [host("running")], lifecycle), null);
  assert.equal(stoppedHostRecoverySession("factory", [host("stopped")], { ...lifecycle, observedState: "ready" }), null);
});

test("a player is handed the pack for the release the world is running", () => {
  assert.deepEqual(
    packRelease({ state: "available", generationId: "generation-1", activeRelease: "1.1", desiredRelease: "1.2" }),
    { kind: "release", release: "1.1" },
    "a desired release has not been through a start; its pack would fit a world nobody is playing",
  );
  assert.deepEqual(
    packRelease({ state: "available", generationId: "generation-1", activeRelease: null, desiredRelease: "1.2" }),
    { kind: "release", release: "1.2" },
  );
  assert.deepEqual(
    packRelease({ state: "available", generationId: "generation-1", activeRelease: null, desiredRelease: null }),
    { kind: "none", reason: "no_release_selected" },
  );
  assert.deepEqual(
    packRelease({ state: "unconfigured", generationId: null, activeRelease: null, desiredRelease: null }),
    { kind: "none", reason: "no_release_pointer" },
  );
  assert.deepEqual(packRelease(null), { kind: "none", reason: "no_release_pointer" });
});

test("only an active world can require a verified stop before a lifecycle mutation", () => {
  assert.equal(worldLifecycleNeedsStop("active", "running"), true);
  assert.equal(worldLifecycleNeedsStop("active", "stopped"), false);
  assert.equal(worldLifecycleNeedsStop("archived", "running"), false, "another running world must not be stopped");
});
