import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifecycleCoordinator,
  type LifecycleStore,
  type VersionedLifecycle,
} from "../src/lifecycle/coordinator.ts";
import type { LifecycleRecord } from "../src/domain/lifecycle.ts";

class MemoryStore implements LifecycleStore {
  value: VersionedLifecycle | null = null;
  failNextCompareAndSet = false;

  async read(): Promise<VersionedLifecycle | null> {
    return this.value;
  }

  async create(_serverId: string, record: LifecycleRecord): Promise<boolean> {
    if (this.value !== null) return false;
    this.value = { revision: 1, record };
    return true;
  }

  async compareAndSet(
    _serverId: string,
    expectedRevision: number,
    record: LifecycleRecord,
  ): Promise<boolean> {
    if (this.failNextCompareAndSet) {
      this.failNextCompareAndSet = false;
      return false;
    }
    if (this.value?.revision !== expectedRevision) return false;
    this.value = { revision: expectedRevision + 1, record };
    return true;
  }
}

test("coordinator persists a complete session through optimistic conditional writes", async () => {
  const store = new MemoryStore();
  let now = 1_786_665_600;
  const coordinate = createLifecycleCoordinator(store, () => now++);

  const initialized = await coordinate({ action: "initialize", serverId: "minecraft" });
  assert.equal(initialized.revision, 1);
  const acquired = await coordinate({
    action: "acquireLease",
    serverId: "minecraft",
    operationId: "start-op",
    ttlSeconds: 300,
  });
  assert.equal(acquired.revision, 2);
  assert.ok(acquired.ownership);

  await coordinate({
    action: "beginSession",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
    worldId: "world-1",
  });
  await coordinate({
    action: "markSessionReady",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
  });
  await coordinate({
    action: "registerWatchdog",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
    watchdogExecutionId: "watchdog-1",
  });
  await coordinate({
    action: "releaseLease",
    serverId: "minecraft",
    ownership: acquired.ownership,
  });

  for (let observation = 1; observation <= 3; observation += 1) {
    await coordinate({
      action: "recordPlayerObservation",
      serverId: "minecraft",
      sessionId: "session-1",
      watchdogExecutionId: "watchdog-1",
      observationId: `observation-${observation}`,
      playersOnline: 0,
    });
  }
  const eligible = await coordinate({
    action: "isIdleStopEligible",
    serverId: "minecraft",
    sessionId: "session-1",
    watchdogExecutionId: "watchdog-1",
    threshold: 3,
  });
  assert.equal(eligible.idleStopEligible, true);
});

test("coordinator retries a lost compare-and-set race without losing a transition", async () => {
  const store = new MemoryStore();
  const coordinate = createLifecycleCoordinator(store, () => 1_786_665_600);
  await coordinate({ action: "initialize", serverId: "minecraft" });
  store.failNextCompareAndSet = true;

  const acquired = await coordinate({
    action: "acquireLease",
    serverId: "minecraft",
    operationId: "start-op",
    ttlSeconds: 300,
  });

  assert.equal(acquired.revision, 2);
  assert.equal(acquired.ownership?.fencingToken, 1);
});

test("initialize and same-owner lease acquisition remain idempotent", async () => {
  const store = new MemoryStore();
  const coordinate = createLifecycleCoordinator(store, () => 1_786_665_600);
  const first = await coordinate({ action: "initialize", serverId: "minecraft" });
  const retry = await coordinate({ action: "initialize", serverId: "minecraft" });
  assert.deepEqual(retry, first);

  const acquired = await coordinate({
    action: "acquireLease",
    serverId: "minecraft",
    operationId: "start-op",
    ttlSeconds: 300,
  });
  const acquiredRetry = await coordinate({
    action: "acquireLease",
    serverId: "minecraft",
    operationId: "start-op",
    ttlSeconds: 300,
  });
  assert.deepEqual(acquiredRetry, acquired);
});

test("coordinator cancels a player-race stop without changing session identity", async () => {
  const store = new MemoryStore();
  let now = 1_786_665_600;
  const coordinate = createLifecycleCoordinator(store, () => now++);
  await coordinate({ action: "initialize", serverId: "minecraft" });
  const acquired = await coordinate({
    action: "acquireLease",
    serverId: "minecraft",
    operationId: "session-op",
    ttlSeconds: 300,
  });
  assert.ok(acquired.ownership);
  await coordinate({
    action: "beginSession",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
    worldId: "world-1",
  });
  await coordinate({
    action: "markSessionReady",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
  });
  await coordinate({
    action: "beginStopping",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
  });
  const cancelled = await coordinate({
    action: "cancelStopping",
    serverId: "minecraft",
    ownership: acquired.ownership,
    sessionId: "session-1",
  });

  assert.equal(cancelled.record.desiredState, "running");
  assert.equal(cancelled.record.observedState, "ready");
  assert.equal(cancelled.record.activeSessionId, "session-1");
});
