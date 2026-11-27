import assert from "node:assert/strict";
import test from "node:test";

import { eventJournalItem, executionChange, hostOwnsSession, parseDynamicProjection, recoveryTarget, withExecutionChange } from "../src/control-plane/dynamic-projection.ts";
import { initialLifecycleRecord } from "../src/domain/lifecycle.ts";
import type { HostObservation } from "../src/control-plane/read-model.ts";

const host: HostObservation = {
  id: "spawnpoint-game-host", name: "spawnpoint-game-host", state: "stopped", providerRef: "i-123",
  instanceType: "m7i-flex.large", availabilityZone: "eu-central-1a", launchedAt: null, publicIp: null,
};

test("a fresh valid dynamic projection round-trips and a stale one falls back", () => {
  const stored = {
    schema_version: 1,
    observed_at_epoch_ms: 1_000,
    hosts: [host],
    operations: [{ id: "start-1", type: "start", status: "running", startedAt: "2026-09-15T00:00:00.000Z", providerRef: "arn:execution" }],
  };
  assert.equal(parseDynamicProjection(stored, 1_500)?.operations[0]?.id, "start-1");
  assert.equal(parseDynamicProjection(stored, 1_000 + 10 * 60 * 1000 + 1), null);
  assert.equal(parseDynamicProjection({ ...stored, hosts: [{ ...host, state: "teleported" }] }, 1_500), null);
});

test("event history keeps provider identity and status but drops arbitrary payload", () => {
  const stored = eventJournalItem({
    id: "12345678-1234-1234-1234-123456789abc",
    source: "aws.states",
    "detail-type": "Step Functions Execution Status Change",
    time: "2026-09-15T00:00:00.000Z",
    detail: { executionArn: "arn:execution", stateMachineArn: "arn:machine", status: "FAILED", input: "secret", output: "secret" },
  }, 1234);
  assert.deepEqual(stored.detail, { executionArn: "arn:execution", stateMachineArn: "arn:machine", status: "FAILED" });
  assert.equal(JSON.stringify(stored).includes("secret"), false);
});

test("only one expired stranded session on an observed stopped host can recover", () => {
  const stranded = {
    ...initialLifecycleRecord("factorio", 1),
    desiredState: "stopped" as const,
    observedState: "stopping" as const,
    activeSessionId: "session-1",
    activeWorldId: "factorio-test",
    lease: { ownerOperationId: "failed-stop", fencingToken: 1, expiresAtEpochSeconds: 100 },
  };
  assert.deepEqual(recoveryTarget([host], [], [stranded], 101), {
    serverId: "factorio", sessionId: "session-1", worldId: "factorio-test", instanceId: "i-123",
  });
  assert.equal(recoveryTarget([host], [], [stranded], 99), null);
  assert.equal(recoveryTarget([host], [], [stranded, { ...stranded, serverId: "minecraft" }], 101), null);
  assert.equal(recoveryTarget([host], [{ id: "active", type: "start", status: "running", startedAt: "2026-09-15T00:00:00.000Z", providerRef: "arn:execution", worldId: null }], [stranded], 101), null);
  assert.equal(recoveryTarget([host], [], [{ ...stranded, observedState: "stopped", activeSessionId: null, activeWorldId: null }], 101), null);
});

test("a fleet host does not keep the configured host's stranded session from recovering", () => {
  const stranded = {
    ...initialLifecycleRecord("factorio", 1),
    observedState: "stopping" as const,
    activeSessionId: "session-1",
    activeWorldId: "factorio-test",
    lease: null,
  };
  const fleet: HostObservation = { ...host, id: "fleet-1", providerRef: "i-fleet", state: "running", provenance: "launched" };
  assert.deepEqual(recoveryTarget([fleet, host], [], [stranded], 101), {
    serverId: "factorio", sessionId: "session-1", worldId: "factorio-test", instanceId: "i-123",
  });
  assert.equal(recoveryTarget([fleet], [], [stranded], 101), null);
  assert.equal(recoveryTarget([fleet, host, { ...host, id: "second", providerRef: "i-456" }], [], [stranded], 101), null);
});

test("a manually stopped ready session is reconciled without a special UI command", () => {
  const ready = {
    ...initialLifecycleRecord("factorio", 1),
    desiredState: "running" as const,
    observedState: "ready" as const,
    activeSessionId: "session-1",
    activeWorldId: "factorio-test",
  };
  assert.deepEqual(recoveryTarget([host], [], [ready], 101), {
    serverId: "factorio", sessionId: "session-1", worldId: "factorio-test", instanceId: "i-123",
  });
});

test("stopped-host recovery requires the exact session to be reserved on that host", () => {
  const onConfiguredHost = {
    hostId: "i-123",
    reservations: [{ sessionId: "session-1" }],
  };
  assert.equal(hostOwnsSession(onConfiguredHost, "i-123", "session-1"), true);
  assert.equal(hostOwnsSession(onConfiguredHost, "i-123", "session-2"), false);
  assert.equal(hostOwnsSession(onConfiguredHost, "i-fleet", "session-1"), false);
  assert.equal(hostOwnsSession(null, "i-123", "session-1"), false);
  assert.equal(hostOwnsSession({ hostId: "i-123", reservations: null }, "i-123", "session-1"), false);
});

test("a stored operation keeps its expected time and drops a malformed one", () => {
  const stored = (extra: Record<string, unknown>) => ({
    schema_version: 1,
    observed_at_epoch_ms: 1_000,
    hosts: [],
    operations: [{ id: "start-1", type: "start", status: "running", startedAt: "2026-09-15T00:00:00.000Z", providerRef: "arn:execution", worldId: "w1", ...extra }],
  });

  const kept = parseDynamicProjection(stored({ expectedSeconds: 100, expectedSamples: 7 }), 1_500)?.operations[0];
  assert.equal(kept?.expectedSeconds, 100);
  assert.equal(kept?.expectedSamples, 7);

  const dropped = parseDynamicProjection(stored({ expectedSeconds: "soon", expectedSamples: 7 }), 1_500)?.operations[0];
  assert.equal(dropped?.id, "start-1");
  assert.equal(dropped?.expectedSeconds, undefined);
});

test("a launched host keeps its provenance and market when the projection is read back", () => {
  const launched = { ...host, id: "fleet-1", providerRef: "i-fleet", provenance: "launched", market: "spot" };
  const parsed = parseDynamicProjection({ schema_version: 1, observed_at_epoch_ms: 1_000, hosts: [host, launched], operations: [] }, 1_500);
  assert.equal(parsed?.hosts[0]?.provenance, undefined);
  assert.equal(parsed?.hosts[1]?.provenance, "launched");
  assert.equal(parsed?.hosts[1]?.market, "spot");
  assert.equal(parseDynamicProjection({ schema_version: 1, observed_at_epoch_ms: 1_000, hosts: [{ ...launched, provenance: "borrowed" }], operations: [] }, 1_500)?.hosts[0]?.provenance, undefined);
});

const running = (id: string, startedAt = "2026-09-15T00:00:00.000Z") =>
  ({ id, type: "start" as const, status: "running" as const, startedAt, providerRef: `arn:${id}`, worldId: "w1" });
const statusEvent = (executionArn: string, status: string) =>
  ({ id: "event-1", source: "aws.states", "detail-type": "Step Functions Execution Status Change", time: "2026-09-15T00:00:00.000Z", detail: { executionArn, status } });

test("an ended run leaves the list even when the stale listing still has it", async () => {
  const listed = [running("a"), running("b")];
  const never = async () => { throw new Error("no read for an ended run"); };
  for (const status of ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]) {
    const result = await withExecutionChange(listed, executionChange(statusEvent("arn:a", status)), never);
    assert.deepEqual(result.map((operation) => operation.id), ["b"], status);
  }
});

test("a started run missing from the listing is added only when a consistent read confirms it", async () => {
  const listed = [running("b", "2026-09-15T00:00:00.000Z")];
  const late = running("a", "2026-09-15T00:01:00.000Z");
  assert.deepEqual((await withExecutionChange(listed, executionChange(statusEvent("arn:a", "RUNNING")), async () => late)).map((o) => o.id), ["a", "b"]);
  assert.deepEqual((await withExecutionChange(listed, executionChange(statusEvent("arn:a", "RUNNING")), async () => null)).map((o) => o.id), ["b"]);
  let reads = 0;
  await withExecutionChange([late], executionChange(statusEvent("arn:a", "RUNNING")), async () => { reads += 1; return late; });
  assert.equal(reads, 0);
});

test("an event that is not a run's status change leaves the list as read", async () => {
  const ec2 = { id: "event-2", source: "aws.ec2", "detail-type": "EC2 Instance State-change Notification", time: "2026-09-15T00:00:00.000Z", detail: { "instance-id": "i-1", state: "stopped" } };
  assert.equal(executionChange(ec2), null);
  const listed = [running("a")];
  assert.equal(await withExecutionChange(listed, null, async () => null), listed);
});
