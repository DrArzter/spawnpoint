// What an operation is doing, read from the record its workflow writes
// (ADR-0105). Nothing here reads Step Functions: the record says the step, the
// nested run, the host and the command.

import type { OperationProgress } from "../../../contract/operations.ts";
import type { HostLogLine } from "./host-log.ts";
import { scrub } from "./operation-progress.ts";
import type { OperationRecord } from "./operation-record.ts";
import { ENDED, STEP_LABELS, type OperationStep } from "./operation-steps.ts";
import type { OperationObservation } from "./read-model.ts";

/** The records of the operations, read through one port; the adapter is dynamo-operation-records.ts. */
export type OperationRecordStore = Readonly<{
  /** Null when no whole record exists: a run that started before the records did. */
  get: (operationId: string) => Promise<OperationRecord | null>;
  /** The records that run now, outer and nested. */
  listOpen: () => Promise<readonly OperationRecord[]>;
}>;

/** The host command whose output the log shows. */
export type HostCommand = Readonly<{ instanceId: string; commandId: string }>;

/** A start nests the host start; a promotion nests a start, which nests the host start. */
const MAX_CHILD_DEPTH = 2;
const MAX_ERROR = 200;
const MAX_CAUSE = 1000;

function stepOfKey(key: string | null): OperationStep | null {
  if (key === null || key === ENDED) return null;
  const label = STEP_LABELS[key];
  return label === undefined ? null : { key, label };
}

/** A running outer record as the snapshot lists it; nested runs are followed through their outer run. */
export function observationOfRecord(record: OperationRecord): OperationObservation | null {
  if (record.status !== "running" || record.parentId !== null) return null;
  return {
    id: record.operationId,
    type: record.type,
    status: "running",
    startedAt: record.startedAt,
    providerRef: record.executionArn ?? record.operationId,
    worldId: record.worldId,
  };
}

/**
 * The running operations: the open outer records, and each listed execution
 * that has no record at all (it started before the records did). A run whose
 * record exists is the record's to tell, also when the record says it ended.
 */
export async function runningOperations(
  open: readonly OperationRecord[],
  executions: readonly OperationObservation[],
  hasRecord: (operationId: string) => Promise<boolean>,
): Promise<Readonly<{ recorded: OperationObservation[]; unrecorded: OperationObservation[] }>> {
  const known = new Set(open.map((record) => record.operationId));
  const unrecorded = (await Promise.all(executions.map(async (execution) =>
    known.has(execution.id) || await hasRecord(execution.id) ? null : execution)))
    .filter((execution) => execution !== null);
  const recorded = open.flatMap((record) => { const observation = observationOfRecord(record); return observation === null ? [] : [observation]; });
  return { recorded, unrecorded };
}

// The deepest nested run that runs now and shows a step, from the outer record down.
async function deepestChild(store: OperationRecordStore, record: OperationRecord, depth: number): Promise<OperationProgress["child"]> {
  if (depth > MAX_CHILD_DEPTH || record.childId === null) return null;
  const child = await store.get(record.childId);
  if (child === null || child.status !== "running" || child.parentId !== record.operationId) return null;
  const step = stepOfKey(child.step);
  if (step === null || (child.type !== "start" && child.type !== "stop")) return null;
  return await deepestChild(store, child, depth + 1) ?? { type: child.type, step };
}

/**
 * The progress of one operation of one world, from its record. `expectation`
 * is read only while it runs; the host log only for a start or a promotion
 * that runs or failed, and only once the record names the host and the command.
 */
export async function progressOfRecord(
  store: OperationRecordStore,
  record: OperationRecord,
  request: Readonly<{
    now: Date;
    expectation?: () => Promise<Readonly<{ expectedSeconds: number; expectedSamples: number }> | null>;
    hostLog?: (command: HostCommand) => Promise<readonly HostLogLine[]>;
  }>,
): Promise<OperationProgress> {
  const running = record.status === "running";
  const failed = record.status === "failed" || record.status === "timed_out" || record.status === "aborted";
  const started = new Date(record.startedAt);
  const ended = record.endedAt === null ? null : new Date(record.endedAt);
  const end = running || ended === null ? request.now : ended;
  const expectation = running ? await request.expectation?.() ?? null : null;
  const child = running ? await deepestChild(store, record, 1) : null;
  const hostLog = (running || failed) && (record.type === "start" || record.type === "promote") && request.hostLog !== undefined
    ? await readHostLog(record, request.hostLog)
    : null;
  return {
    id: record.operationId,
    type: record.type,
    status: record.status,
    startedAt: started.toISOString(),
    stoppedAt: running ? null : ended?.toISOString() ?? null,
    elapsedSeconds: Math.max(0, Math.round((end.getTime() - started.getTime()) / 1000)),
    ...expectation,
    step: running ? stepOfKey(record.step) : null,
    child,
    result: record.status === "succeeded" ? record.result : null,
    failure: failed ? { error: scrub(record.error ?? record.status.toUpperCase(), MAX_ERROR), cause: scrub(record.cause ?? "", MAX_CAUSE) } : null,
    ...(hostLog === null ? {} : { hostLog }),
    caught: record.caught === null ? null : {
      error: scrub(record.caught.error, MAX_ERROR),
      cause: scrub(record.caught.cause, MAX_CAUSE),
      step: stepOfKey(record.caught.step),
    },
  };
}

// The log is a courtesy: when it cannot be read the operation is still told.
async function readHostLog(record: OperationRecord, read: (command: HostCommand) => Promise<readonly HostLogLine[]>): Promise<readonly HostLogLine[] | null> {
  if (record.hostInstanceId === null || record.commandId === null) return [];
  try {
    return await read({ instanceId: record.hostInstanceId, commandId: record.commandId });
  } catch (error) {
    console.warn("could not read the host log of an operation", record.operationId, error);
    return null;
  }
}
