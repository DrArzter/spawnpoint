export type DesiredServerState = "stopped" | "running";
export type ObservedServerState = "stopped" | "starting" | "ready" | "stopping" | "unknown";

export type Lease = Readonly<{
  ownerOperationId: string;
  fencingToken: number;
  expiresAtEpochSeconds: number;
}>;

export type LeaseOwnership = Readonly<{
  ownerOperationId: string;
  fencingToken: number;
}>;

export type IdleState = Readonly<{
  watchdogExecutionId: string;
  consecutiveEmpty: number;
  lastObservationId: string | null;
  lastObservedAtEpochSeconds: number | null;
  /**
   * The count behind `consecutiveEmpty`, kept rather than reduced away. The
   * watchdog reads it to decide whether to stop; it is also the one number a
   * player most wants from a game server, and nothing else in the system knows
   * it. `null` is a read that failed, which is not the same as nobody online.
   */
  playersOnline: number | null;
}>;

export type LifecycleRecord = Readonly<{
  schemaVersion: 1;
  serverId: string;
  desiredState: DesiredServerState;
  observedState: ObservedServerState;
  activeSessionId: string | null;
  activeWorldId: string | null;
  /**
   * What a player types, as the host reported it when the session became
   * ready (ADR-0033: the address is born on the host). Null until then, and a
   * record written before this field existed reads as null.
   */
  activeSessionAddress?: string | null;
  fencingToken: number;
  lease: Lease | null;
  idle: IdleState | null;
  updatedAtEpochSeconds: number;
}>;

export type LeaseAcquisition = Readonly<{
  record: LifecycleRecord;
  ownership: LeaseOwnership;
}>;

export class LifecycleConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleConflict";
  }
}

function requireId(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function requireEpoch(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function requireOwnership(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  nowEpochSeconds: number,
): void {
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  const lease = record.lease;
  if (
    lease === null ||
    lease.ownerOperationId !== ownership.ownerOperationId ||
    lease.fencingToken !== ownership.fencingToken ||
    lease.expiresAtEpochSeconds <= nowEpochSeconds
  ) {
    throw new LifecycleConflict("operation does not own the current unexpired lifecycle lease");
  }
}

function requireSession(record: LifecycleRecord, sessionId: string): void {
  requireId("sessionId", sessionId);
  if (record.activeSessionId !== sessionId) {
    throw new LifecycleConflict(`session ${sessionId} is not the active session`);
  }
}

export function initialLifecycleRecord(
  serverId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireId("serverId", serverId);
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  return {
    schemaVersion: 1,
    serverId,
    desiredState: "stopped",
    observedState: "stopped",
    activeSessionId: null,
    activeWorldId: null,
    activeSessionAddress: null,
    fencingToken: 0,
    lease: null,
    idle: null,
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function acquireLease(
  record: LifecycleRecord,
  ownerOperationId: string,
  nowEpochSeconds: number,
  ttlSeconds: number,
): LeaseAcquisition {
  requireId("ownerOperationId", ownerOperationId);
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  requirePositiveInteger("ttlSeconds", ttlSeconds);

  const current = record.lease;
  if (current !== null && current.expiresAtEpochSeconds > nowEpochSeconds) {
    if (current.ownerOperationId !== ownerOperationId) {
      throw new LifecycleConflict(`lease is held by ${current.ownerOperationId}`);
    }
    return {
      record,
      ownership: {
        ownerOperationId: current.ownerOperationId,
        fencingToken: current.fencingToken,
      },
    };
  }

  const fencingToken = record.fencingToken + 1;
  const lease = {
    ownerOperationId,
    fencingToken,
    expiresAtEpochSeconds: nowEpochSeconds + ttlSeconds,
  };
  return {
    record: {
      ...record,
      fencingToken,
      lease,
      updatedAtEpochSeconds: nowEpochSeconds,
    },
    ownership: { ownerOperationId, fencingToken },
  };
}

export function renewLease(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  nowEpochSeconds: number,
  ttlSeconds: number,
): LifecycleRecord {
  requirePositiveInteger("ttlSeconds", ttlSeconds);
  requireOwnership(record, ownership, nowEpochSeconds);
  return {
    ...record,
    lease: {
      ownerOperationId: ownership.ownerOperationId,
      fencingToken: ownership.fencingToken,
      expiresAtEpochSeconds: nowEpochSeconds + ttlSeconds,
    },
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function releaseLease(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  return { ...record, lease: null, updatedAtEpochSeconds: nowEpochSeconds };
}

export function beginSession(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  worldId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireId("sessionId", sessionId);
  requireId("worldId", worldId);

  if (
    record.activeSessionId === sessionId &&
    record.activeWorldId === worldId &&
    record.desiredState === "running" &&
    record.observedState === "starting"
  ) {
    return record;
  }
  if (
    record.desiredState !== "stopped" ||
    record.observedState !== "stopped" ||
    record.activeSessionId !== null ||
    record.activeWorldId != null
  ) {
    throw new LifecycleConflict("a new session can begin only from fully stopped state");
  }

  return {
    ...record,
    desiredState: "running",
    observedState: "starting",
    activeSessionId: sessionId,
    activeWorldId: worldId,
    activeSessionAddress: null,
    idle: null,
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function markSessionReady(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  nowEpochSeconds: number,
  connectionAddress: string | null = null,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireSession(record, sessionId);
  if (connectionAddress !== null && !connectionAddress.trim()) throw new Error("connectionAddress must not be empty");
  if (record.observedState === "ready" && record.desiredState === "running") {
    // A repeated mark may bring the address a first one lacked; it never takes one away.
    return connectionAddress === null || connectionAddress === record.activeSessionAddress
      ? record
      : { ...record, activeSessionAddress: connectionAddress, updatedAtEpochSeconds: nowEpochSeconds };
  }
  if (record.observedState !== "starting" || record.desiredState !== "running") {
    throw new LifecycleConflict("only the starting session can become ready");
  }
  return { ...record, observedState: "ready", activeSessionAddress: connectionAddress, updatedAtEpochSeconds: nowEpochSeconds };
}

export function registerWatchdog(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  watchdogExecutionId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireSession(record, sessionId);
  requireId("watchdogExecutionId", watchdogExecutionId);
  if (record.observedState !== "ready" || record.desiredState !== "running") {
    throw new LifecycleConflict("watchdog can be registered only for a ready session");
  }
  if (record.idle !== null) {
    if (record.idle.watchdogExecutionId === watchdogExecutionId) return record;
    throw new LifecycleConflict("the active session already has a watchdog");
  }
  return {
    ...record,
    idle: {
      watchdogExecutionId,
      consecutiveEmpty: 0,
      playersOnline: null,
      lastObservationId: null,
      lastObservedAtEpochSeconds: null,
    },
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function recordPlayerObservation(
  record: LifecycleRecord,
  sessionId: string,
  watchdogExecutionId: string,
  observationId: string,
  playersOnline: number | null,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireEpoch("nowEpochSeconds", nowEpochSeconds);
  requireSession(record, sessionId);
  requireId("watchdogExecutionId", watchdogExecutionId);
  requireId("observationId", observationId);
  if (playersOnline !== null && (!Number.isSafeInteger(playersOnline) || playersOnline < 0)) {
    throw new Error("playersOnline must be a non-negative integer or null for a failed read");
  }
  if (
    record.desiredState !== "running" ||
    record.observedState !== "ready" ||
    record.idle?.watchdogExecutionId !== watchdogExecutionId
  ) {
    throw new LifecycleConflict("observation does not belong to the active ready session watchdog");
  }
  if (record.idle.lastObservationId === observationId) return record;

  return {
    ...record,
    idle: {
      ...record.idle,
      consecutiveEmpty:
        playersOnline === 0 ? record.idle.consecutiveEmpty + 1 : 0,
      playersOnline,
      lastObservationId: observationId,
      lastObservedAtEpochSeconds: nowEpochSeconds,
    },
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function isIdleStopEligible(
  record: LifecycleRecord,
  sessionId: string,
  watchdogExecutionId: string,
  threshold: number,
): boolean {
  requirePositiveInteger("threshold", threshold);
  return (
    record.desiredState === "running" &&
    record.observedState === "ready" &&
    record.activeSessionId === sessionId &&
    record.idle?.watchdogExecutionId === watchdogExecutionId &&
    record.idle.consecutiveEmpty >= threshold
  );
}

export function beginStopping(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireSession(record, sessionId);
  if (record.observedState === "stopping" && record.desiredState === "stopped") return record;
  if (
    record.desiredState !== "running" ||
    (record.observedState !== "starting" && record.observedState !== "ready")
  ) {
    throw new LifecycleConflict("only an active session can begin stopping");
  }
  return {
    ...record,
    desiredState: "stopped",
    observedState: "stopping",
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function cancelStopping(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireSession(record, sessionId);
  if (record.desiredState === "running" && record.observedState === "ready") return record;
  if (record.desiredState !== "stopped" || record.observedState !== "stopping") {
    throw new LifecycleConflict("only a stopping session can return to ready");
  }
  return {
    ...record,
    desiredState: "running",
    observedState: "ready",
    idle: record.idle === null ? null : { ...record.idle, consecutiveEmpty: 0 },
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}

export function markStopped(
  record: LifecycleRecord,
  ownership: LeaseOwnership,
  sessionId: string,
  nowEpochSeconds: number,
): LifecycleRecord {
  requireOwnership(record, ownership, nowEpochSeconds);
  requireSession(record, sessionId);
  if (record.desiredState !== "stopped" || record.observedState !== "stopping") {
    throw new LifecycleConflict("only the stopping session can become stopped");
  }
  return {
    ...record,
    observedState: "stopped",
    activeSessionId: null,
    activeWorldId: null,
    activeSessionAddress: null,
    idle: null,
    updatedAtEpochSeconds: nowEpochSeconds,
  };
}
