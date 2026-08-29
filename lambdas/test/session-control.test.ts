import assert from "node:assert/strict";
import test from "node:test";

import type { HostObservation, OperationObservation } from "../src/control-plane/read-model.ts";
import { planSessionOperation } from "../src/control-plane/session-control.ts";

const host = (state: HostObservation["state"]): HostObservation => ({ id: "host", name: "Host", state, providerRef: "i-1", instanceType: null, availabilityZone: null, launchedAt: null });
const operation: OperationObservation = { id: "op", type: "start", status: "running", startedAt: "2026-08-29T00:00:00Z", providerRef: "arn:op" };

test("only the world supported by the deployed V1 workflow can execute", () => {
  assert.equal(planSessionOperation("minecraft", "world", "start", [host("stopped")], []).kind, "execute");
  assert.deepEqual(planSessionOperation("minecraft", "vanilla", "start", [host("stopped")], []), { kind: "reject", reason: "unsupported_world" });
  assert.deepEqual(planSessionOperation("factorio", "factorio", "start", [host("stopped")], []), { kind: "reject", reason: "unsupported_world" });
  assert.deepEqual(planSessionOperation("minecraft", "missing", "start", [host("stopped")], []), { kind: "reject", reason: "unknown_world" });
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
