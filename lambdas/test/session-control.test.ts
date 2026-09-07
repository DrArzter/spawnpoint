import assert from "node:assert/strict";
import test from "node:test";

import type { HostObservation, OperationObservation } from "../src/control-plane/read-model.ts";
import { catalogWithPresets } from "../src/control-plane/catalog.ts";
import { packRelease, planSessionOperation } from "../src/control-plane/session-control.ts";

const host = (state: HostObservation["state"]): HostObservation => ({ id: "host", name: "Host", state, providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null, publicIp: null });
const operation: OperationObservation = { id: "op", type: "start", status: "running", startedAt: "2026-08-29T00:00:00Z", providerRef: "arn:op" };

test("any world in the catalog can execute, because the machines take a world id", () => {
  const catalog = catalogWithPresets([{
    id: "factorio-vanilla", displayName: "Factorio vanilla", gameId: "factorio",
    repository: "https://github.com/example/factorio", commit: "1".repeat(40), profileDigest: "2".repeat(64),
    buildStatus: "ready", latestRelease: "1.0",
  }]);
  assert.equal(planSessionOperation("minecraft", "world", "start", [host("stopped")], []).kind, "execute");
  assert.equal(planSessionOperation("minecraft", "vanilla", "start", [host("stopped")], []).kind, "execute");
  assert.equal(planSessionOperation("factorio", "factorio-vanilla", "start", [host("stopped")], [], catalog).kind, "execute");
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

test("stop is idempotent and transitional host states are rejected", () => {
  assert.deepEqual(planSessionOperation("minecraft", "world", "stop", [host("stopped")], []), { kind: "noop", reason: "already_stopped" });
  assert.equal(planSessionOperation("minecraft", "world", "stop", [host("running")], []).kind, "execute");
  assert.deepEqual(planSessionOperation("minecraft", "world", "start", [host("stopping")], []), { kind: "reject", reason: "host_transitioning" });
});

test("a player is handed the pack for the release the world is running", () => {
  assert.deepEqual(
    packRelease({ state: "available", activeRelease: "1.1", desiredRelease: "1.2" }),
    { kind: "release", release: "1.1" },
    "a desired release has not been through a start; its pack would fit a world nobody is playing",
  );
  assert.deepEqual(
    packRelease({ state: "available", activeRelease: null, desiredRelease: "1.2" }),
    { kind: "release", release: "1.2" },
  );
  assert.deepEqual(
    packRelease({ state: "available", activeRelease: null, desiredRelease: null }),
    { kind: "none", reason: "no_release_selected" },
  );
  assert.deepEqual(
    packRelease({ state: "unconfigured", activeRelease: null, desiredRelease: null }),
    { kind: "none", reason: "no_release_pointer" },
  );
  assert.deepEqual(packRelease(null), { kind: "none", reason: "no_release_pointer" });
});
