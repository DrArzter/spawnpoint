import assert from "node:assert/strict";
import test from "node:test";

import { fleetSweepAction } from "../src/domain/fleet-sweep.ts";
import { markReady, markTerminating, markStopped, newHost, release, reserve } from "../src/domain/placement.ts";

const NOW = 1_790_000_000;
const SHAPE = { instanceType: "m7i-flex.large", memoryMiB: 8192, vcpu: 2 };

function emptyFleet() {
  return markReady(newHost("i-fleet", SHAPE, NOW - 10000, "launched"), NOW - 2000);
}

test("a missed drain is retried after grace; a session or a recent drain is never touched", () => {
  const empty = emptyFleet();
  assert.equal(fleetSweepAction("running", NOW - 10000, empty, NOW, 600), "drain");
  assert.equal(fleetSweepAction("running", NOW - 10000, empty, NOW - 1500, 600), "none");
  const busy = reserve(empty, { sessionId: "s1", worldId: "world", footprint: { memoryMiB: 1024, cores: 0.5 }, policy: "cold" }, NOW - 1000);
  assert.equal(fleetSweepAction("running", NOW - 10000, busy, NOW, 600), "none");
  assert.equal(fleetSweepAction("stopped", NOW - 10000, busy, NOW, 600), "alarm");
  const draining = release(busy, "s1", NOW - 100);
  assert.equal(fleetSweepAction("running", NOW - 10000, draining, NOW, 600), "none");
});

test("a fenced termination retries EC2; a warm stopped host mismatch alarms", () => {
  const empty = emptyFleet();
  assert.equal(fleetSweepAction("running", NOW - 10000, markTerminating(empty, NOW - 100), NOW, 600), "terminate");
  const stopped = markStopped(empty, NOW - 1000);
  assert.equal(fleetSweepAction("running", NOW - 10000, stopped, NOW, 600), "alarm");
  assert.equal(fleetSweepAction("stopped", NOW - 10000, stopped, NOW, 600), "none");
});

test("unknown, configured, and inconsistent hosts require review rather than deletion", () => {
  assert.equal(fleetSweepAction("running", NOW - 4000, null, NOW, 600), "alarm");
  assert.equal(fleetSweepAction("running", NOW - 10, null, NOW, 600), "none");
  const configured = markReady(newHost("i-configured", SHAPE, NOW - 10000), NOW - 2000);
  assert.equal(fleetSweepAction("running", NOW - 10000, configured, NOW, 600), "alarm");
  assert.equal(fleetSweepAction("pending", NOW - 10000, null, NOW, 600), "none");
});
