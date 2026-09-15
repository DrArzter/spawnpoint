import assert from "node:assert/strict";
import test from "node:test";

import { eventJournalItem, parseDynamicProjection, recoveryTarget } from "../src/control-plane/dynamic-projection.ts";
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
  assert.equal(recoveryTarget([host], [{ id: "active", type: "start", status: "running", startedAt: "2026-09-15T00:00:00.000Z", providerRef: "arn:execution" }], [stranded], 101), null);
  assert.equal(recoveryTarget([host], [], [{ ...stranded, observedState: "stopped", activeSessionId: null, activeWorldId: null }], 101), null);
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
