import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleConflict,
  acquireLease,
  beginSession,
  beginStopping,
  cancelStopping,
  initialLifecycleRecord,
  isIdleStopEligible,
  markSessionReady,
  markStopped,
  recordPlayerObservation,
  registerWatchdog,
  releaseLease,
  renewLease,
} from "../src/domain/lifecycle.ts";

const NOW = 1_786_665_600;

function readySession() {
  const acquired = acquireLease(initialLifecycleRecord("minecraft", NOW), "start-op", NOW, 300);
  const starting = beginSession(acquired.record, acquired.ownership, "session-1", NOW + 1);
  const ready = markSessionReady(starting, acquired.ownership, "session-1", NOW + 2);
  return { record: ready, ownership: acquired.ownership };
}

test("lease acquisition is idempotent for its owner and excludes a concurrent operation", () => {
  const initial = initialLifecycleRecord("minecraft", NOW);
  const first = acquireLease(initial, "start-op", NOW, 300);
  const retry = acquireLease(first.record, "start-op", NOW + 1, 300);

  assert.equal(retry.record, first.record);
  assert.deepEqual(retry.ownership, first.ownership);
  assert.throws(
    () => acquireLease(first.record, "stop-op", NOW + 1, 300),
    LifecycleConflict,
  );
});

test("an expired lease can be taken over only with a higher fencing token", () => {
  const first = acquireLease(initialLifecycleRecord("minecraft", NOW), "dead-op", NOW, 10);
  const replacement = acquireLease(first.record, "recovery-op", NOW + 10, 300);

  assert.equal(first.ownership.fencingToken, 1);
  assert.equal(replacement.ownership.fencingToken, 2);
  assert.throws(
    () => beginSession(replacement.record, first.ownership, "stale-session", NOW + 11),
    LifecycleConflict,
  );
});

test("an expired owner cannot renew or release itself back into authority", () => {
  const acquired = acquireLease(initialLifecycleRecord("minecraft", NOW), "start-op", NOW, 10);

  assert.throws(
    () => renewLease(acquired.record, acquired.ownership, NOW + 10, 300),
    LifecycleConflict,
  );
  assert.throws(
    () => releaseLease(acquired.record, acquired.ownership, NOW + 10),
    LifecycleConflict,
  );
});

test("session transitions require the current lease and exact session id", () => {
  const acquired = acquireLease(initialLifecycleRecord("minecraft", NOW), "start-op", NOW, 300);
  const starting = beginSession(acquired.record, acquired.ownership, "session-1", NOW + 1);

  assert.equal(starting.desiredState, "running");
  assert.equal(starting.observedState, "starting");
  assert.throws(
    () => markSessionReady(starting, acquired.ownership, "session-old", NOW + 2),
    LifecycleConflict,
  );
  assert.equal(
    markSessionReady(starting, acquired.ownership, "session-1", NOW + 2).observedState,
    "ready",
  );
});

test("only one watchdog can own a session and its retries are idempotent", () => {
  const { record, ownership } = readySession();
  const watched = registerWatchdog(record, ownership, "session-1", "watchdog-1", NOW + 3);

  assert.equal(
    registerWatchdog(watched, ownership, "session-1", "watchdog-1", NOW + 4),
    watched,
  );
  assert.throws(
    () => registerWatchdog(watched, ownership, "session-1", "watchdog-2", NOW + 4),
    LifecycleConflict,
  );
});

test("only consecutive successful empty readings make idle stop eligible", () => {
  const { record, ownership } = readySession();
  let watched = registerWatchdog(record, ownership, "session-1", "watchdog-1", NOW + 3);
  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-1", 0, NOW + 4);
  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-2", 0, NOW + 5);
  assert.equal(isIdleStopEligible(watched, "session-1", "watchdog-1", 3), false);

  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-failed", null, NOW + 6);
  assert.equal(watched.idle?.consecutiveEmpty, 0);
  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-3", 0, NOW + 7);
  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-4", 0, NOW + 8);
  watched = recordPlayerObservation(watched, "session-1", "watchdog-1", "read-5", 0, NOW + 9);
  assert.equal(isIdleStopEligible(watched, "session-1", "watchdog-1", 3), true);

  const duplicate = recordPlayerObservation(
    watched,
    "session-1",
    "watchdog-1",
    "read-5",
    0,
    NOW + 10,
  );
  assert.equal(duplicate, watched);
  assert.equal(duplicate.idle?.consecutiveEmpty, 3);

  const active = recordPlayerObservation(
    watched,
    "session-1",
    "watchdog-1",
    "read-6",
    1,
    NOW + 11,
  );
  assert.equal(active.idle?.consecutiveEmpty, 0);
});

test("a stale watchdog cannot observe or stop a newer session", () => {
  const first = readySession();
  let record = registerWatchdog(
    first.record,
    first.ownership,
    "session-1",
    "watchdog-1",
    NOW + 3,
  );
  record = beginStopping(record, first.ownership, "session-1", NOW + 4);
  record = markStopped(record, first.ownership, "session-1", NOW + 5);
  record = releaseLease(record, first.ownership, NOW + 6);

  const second = acquireLease(record, "start-op-2", NOW + 7, 300);
  record = beginSession(second.record, second.ownership, "session-2", NOW + 8);
  record = markSessionReady(record, second.ownership, "session-2", NOW + 9);
  record = registerWatchdog(record, second.ownership, "session-2", "watchdog-2", NOW + 10);

  assert.throws(
    () => recordPlayerObservation(record, "session-1", "watchdog-1", "late-read", 0, NOW + 11),
    LifecycleConflict,
  );
  assert.equal(isIdleStopEligible(record, "session-1", "watchdog-1", 1), false);
});

test("stop holds the lease until the exact session is durably stopped", () => {
  const ready = readySession();
  const stopping = beginStopping(ready.record, ready.ownership, "session-1", NOW + 3);

  assert.equal(stopping.desiredState, "stopped");
  assert.equal(stopping.observedState, "stopping");
  assert.throws(
    () => acquireLease(stopping, "start-op-2", NOW + 4, 300),
    LifecycleConflict,
  );

  const stopped = markStopped(stopping, ready.ownership, "session-1", NOW + 5);
  assert.equal(stopped.observedState, "stopped");
  assert.equal(stopped.activeSessionId, null);
  assert.equal(stopped.idle, null);
});

test("a player-race refusal returns the exact stopping session to ready", () => {
  let ready = readySession();
  let record = registerWatchdog(
    ready.record,
    ready.ownership,
    "session-1",
    "watchdog-1",
    NOW + 3,
  );
  record = recordPlayerObservation(record, "session-1", "watchdog-1", "empty-1", 0, NOW + 4);
  record = beginStopping(record, ready.ownership, "session-1", NOW + 5);
  record = cancelStopping(record, ready.ownership, "session-1", NOW + 6);

  assert.equal(record.desiredState, "running");
  assert.equal(record.observedState, "ready");
  assert.equal(record.activeSessionId, "session-1");
  assert.equal(record.idle?.consecutiveEmpty, 0);
  assert.equal(cancelStopping(record, ready.ownership, "session-1", NOW + 7), record);
});
