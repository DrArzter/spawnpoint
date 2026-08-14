import {
  LifecycleConflict,
  acquireLease,
  beginSession,
  beginStopping,
  initialLifecycleRecord,
  isIdleStopEligible,
  markSessionReady,
  markStopped,
  recordPlayerObservation,
  registerWatchdog,
  releaseLease,
  renewLease,
  type LeaseOwnership,
  type LifecycleRecord,
} from "../domain/lifecycle.ts";

export type VersionedLifecycle = Readonly<{
  revision: number;
  record: LifecycleRecord;
}>;

export interface LifecycleStore {
  read(serverId: string): Promise<VersionedLifecycle | null>;
  create(serverId: string, record: LifecycleRecord): Promise<boolean>;
  compareAndSet(
    serverId: string,
    expectedRevision: number,
    record: LifecycleRecord,
  ): Promise<boolean>;
}

type BaseInput = Readonly<{ serverId: string }>;

export type CoordinatorInput =
  | (BaseInput & Readonly<{ action: "initialize" }>)
  | (BaseInput & Readonly<{ action: "get" }>)
  | (BaseInput & Readonly<{ action: "acquireLease"; operationId: string; ttlSeconds: number }>)
  | (BaseInput & Readonly<{ action: "renewLease"; ownership: LeaseOwnership; ttlSeconds: number }>)
  | (BaseInput & Readonly<{ action: "releaseLease"; ownership: LeaseOwnership }>)
  | (BaseInput & Readonly<{ action: "beginSession"; ownership: LeaseOwnership; sessionId: string }>)
  | (BaseInput & Readonly<{ action: "markSessionReady"; ownership: LeaseOwnership; sessionId: string }>)
  | (BaseInput &
      Readonly<{
        action: "registerWatchdog";
        ownership: LeaseOwnership;
        sessionId: string;
        watchdogExecutionId: string;
      }>)
  | (BaseInput &
      Readonly<{
        action: "recordPlayerObservation";
        sessionId: string;
        watchdogExecutionId: string;
        observationId: string;
        playersOnline: number | null;
      }>)
  | (BaseInput &
      Readonly<{
        action: "isIdleStopEligible";
        sessionId: string;
        watchdogExecutionId: string;
        threshold: number;
      }>)
  | (BaseInput & Readonly<{ action: "beginStopping"; ownership: LeaseOwnership; sessionId: string }>)
  | (BaseInput & Readonly<{ action: "markStopped"; ownership: LeaseOwnership; sessionId: string }>);

export type CoordinatorOutput = Readonly<{
  revision: number;
  record: LifecycleRecord;
  ownership?: LeaseOwnership;
  idleStopEligible?: boolean;
}>;

const MAX_CAS_ATTEMPTS = 5;

function requireServerId(serverId: string): void {
  if (typeof serverId !== "string" || !serverId.trim()) {
    throw new Error("serverId must not be empty");
  }
}

export function createLifecycleCoordinator(
  store: LifecycleStore,
  nowEpochSeconds: () => number = () => Math.floor(Date.now() / 1_000),
): (input: CoordinatorInput) => Promise<CoordinatorOutput> {
  async function loadRequired(serverId: string): Promise<VersionedLifecycle> {
    const current = await store.read(serverId);
    if (current === null) {
      throw new LifecycleConflict(`lifecycle ${serverId} is not initialized`);
    }
    return current;
  }

  async function mutate(
    serverId: string,
    mutation: (record: LifecycleRecord, now: number) => Readonly<{
      record: LifecycleRecord;
      ownership?: LeaseOwnership;
    }>,
  ): Promise<CoordinatorOutput> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await loadRequired(serverId);
      const result = mutation(current.record, nowEpochSeconds());
      if (result.record === current.record) {
        return { revision: current.revision, ...result };
      }
      if (await store.compareAndSet(serverId, current.revision, result.record)) {
        return { revision: current.revision + 1, ...result };
      }
    }
    throw new LifecycleConflict("lifecycle changed repeatedly during conditional write");
  }

  return async (input: CoordinatorInput): Promise<CoordinatorOutput> => {
    requireServerId(input.serverId);

    if (input.action === "initialize") {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await store.read(input.serverId);
        if (current !== null) return current;
        const record = initialLifecycleRecord(input.serverId, nowEpochSeconds());
        if (await store.create(input.serverId, record)) return { revision: 1, record };
      }
      throw new LifecycleConflict("lifecycle initialization did not converge");
    }

    if (input.action === "get") return loadRequired(input.serverId);

    if (input.action === "acquireLease") {
      return mutate(input.serverId, (record, now) => {
        const acquisition = acquireLease(record, input.operationId, now, input.ttlSeconds);
        return acquisition;
      });
    }
    if (input.action === "renewLease") {
      return mutate(input.serverId, (record, now) => ({
        record: renewLease(record, input.ownership, now, input.ttlSeconds),
      }));
    }
    if (input.action === "releaseLease") {
      return mutate(input.serverId, (record, now) => ({
        record: releaseLease(record, input.ownership, now),
      }));
    }
    if (input.action === "beginSession") {
      return mutate(input.serverId, (record, now) => ({
        record: beginSession(record, input.ownership, input.sessionId, now),
      }));
    }
    if (input.action === "markSessionReady") {
      return mutate(input.serverId, (record, now) => ({
        record: markSessionReady(record, input.ownership, input.sessionId, now),
      }));
    }
    if (input.action === "registerWatchdog") {
      return mutate(input.serverId, (record, now) => ({
        record: registerWatchdog(
          record,
          input.ownership,
          input.sessionId,
          input.watchdogExecutionId,
          now,
        ),
      }));
    }
    if (input.action === "recordPlayerObservation") {
      return mutate(input.serverId, (record, now) => ({
        record: recordPlayerObservation(
          record,
          input.sessionId,
          input.watchdogExecutionId,
          input.observationId,
          input.playersOnline,
          now,
        ),
      }));
    }
    if (input.action === "isIdleStopEligible") {
      const current = await loadRequired(input.serverId);
      return {
        ...current,
        idleStopEligible: isIdleStopEligible(
          current.record,
          input.sessionId,
          input.watchdogExecutionId,
          input.threshold,
        ),
      };
    }
    if (input.action === "beginStopping") {
      return mutate(input.serverId, (record, now) => ({
        record: beginStopping(record, input.ownership, input.sessionId, now),
      }));
    }
    if (input.action === "markStopped") {
      return mutate(input.serverId, (record, now) => ({
        record: markStopped(record, input.ownership, input.sessionId, now),
      }));
    }

    const unreachable: never = input;
    throw new Error(`unsupported lifecycle action: ${JSON.stringify(unreachable)}`);
  };
}

