/*
 * The record each operation workflow writes of its own run (ADR-0105). The
 * workflows write it with direct DynamoDB tasks; the projector ends a record
 * whose run ended without its own end write; the readers read only this.
 */

import type { ControlPlaneEvent } from "./dynamic-projection.ts";

/** The partition-key prefix of a record; the workflow grants admit only these keys. */
export const OPERATION_RECORD_PREFIX = "OPERATION#";
const RECORD_SORT_KEY = "RECORD";

/** The sparse index of the records that run now: only a running record has `open_key`. */
export const OPEN_OPERATIONS_INDEX = "open_operations";
export const OPEN_KEY_VALUE = "open";

/** The one key of an operation's record. The workflow templates write the same shape; the guard holds them to it. */
export function operationRecordKey(operationId: string): Readonly<{ pk: string; sk: string }> {
  return { pk: `${OPERATION_RECORD_PREFIX}${operationId}`, sk: RECORD_SORT_KEY };
}

/** The operation id of a record key, or null for any other item of the table. */
export function operationIdOfKey(keys: Readonly<Record<string, unknown>>): string | null {
  const { pk, sk } = keys;
  if (typeof pk !== "string" || sk !== RECORD_SORT_KEY || !pk.startsWith(OPERATION_RECORD_PREFIX)) return null;
  const id = pk.slice(OPERATION_RECORD_PREFIX.length);
  return id === "" ? null : id;
}

export type OperationRecordStatus = "running" | "succeeded" | "failed" | "timed_out" | "aborted";
export type OperationRecordType = "start" | "stop" | "promote" | "world" | "host";

/** A record as stored; the workflows write the snake_case attributes, an empty string means none. */
export type OperationRecord = Readonly<{
  operationId: string;
  executionArn: string | null;
  type: OperationRecordType;
  workflow: string | null;
  status: OperationRecordStatus;
  worldId: string | null;
  gameId: string | null;
  serverId: string | null;
  parentId: string | null;
  rootId: string | null;
  childId: string | null;
  step: string | null;
  hostInstanceId: string | null;
  commandId: string | null;
  result: string | null;
  error: string | null;
  cause: string | null;
  caught: Readonly<{ error: string; cause: string; step: string | null }> | null;
  startedAt: string;
  updatedAt: string | null;
  endedAt: string | null;
}>;

const TYPES = new Set<OperationRecordType>(["start", "stop", "promote", "world", "host"]);
const STATUSES = new Set<OperationRecordStatus>(["running", "succeeded", "failed", "timed_out", "aborted"]);

function text(item: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = item[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A stored item as a record; null for an item that is not a whole record (a write before its accepted one). */
export function parseOperationRecord(item: Readonly<Record<string, unknown>> | undefined): OperationRecord | null {
  if (item === undefined) return null;
  const operationId = operationIdOfKey(item);
  const type = text(item, "type");
  const status = text(item, "status");
  const startedAt = text(item, "started_at");
  if (operationId === null || operationId !== text(item, "operation_id") || type === null || !TYPES.has(type as OperationRecordType) ||
      status === null || !STATUSES.has(status as OperationRecordStatus) || startedAt === null) return null;
  const caughtError = text(item, "caught_error");
  return {
    operationId,
    executionArn: text(item, "execution_arn"),
    type: type as OperationRecordType,
    workflow: text(item, "workflow"),
    status: status as OperationRecordStatus,
    worldId: text(item, "world_id"),
    gameId: text(item, "game_id"),
    serverId: text(item, "server_id"),
    parentId: text(item, "parent_id"),
    rootId: text(item, "root_id"),
    // A record never names itself as its child.
    childId: text(item, "child_id") === operationId ? null : text(item, "child_id"),
    step: text(item, "step"),
    hostInstanceId: text(item, "host_instance_id"),
    commandId: text(item, "command_id"),
    result: text(item, "result"),
    error: text(item, "error"),
    cause: text(item, "cause"),
    caught: caughtError === null ? null : { error: caughtError, cause: text(item, "caught_cause") ?? "", step: text(item, "caught_step") },
    startedAt,
    updatedAt: text(item, "updated_at"),
    endedAt: text(item, "ended_at"),
  };
}

export const ENDED_STATUSES: Readonly<Record<string, OperationRecordStatus>> = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  ABORTED: "aborted",
};

/** The execution name, the last part of its ARN: the id of its record. */
export function operationIdOfExecution(executionArn: string): string | null {
  const parts = executionArn.split(":");
  return parts[5] === "execution" && parts.length === 8 && parts[7] !== "" ? parts[7]! : null;
}

export type ExecutionEnd = Readonly<{ executionArn: string; status: string; at: string; error?: string; cause?: string }>;

/** The longest error or cause a record keeps. */
export const MAX_RECORD_TEXT = 1000;

/** The end of a run, from a Step Functions status change; null for any other event or a run still running. */
export function executionEndOf(event: ControlPlaneEvent): ExecutionEnd | null {
  if (event.source !== "aws.states" || event.detail === null || typeof event.detail !== "object") return null;
  const detail = event.detail as Record<string, unknown>;
  const { executionArn, status, error, cause } = detail;
  if (typeof executionArn !== "string" || typeof status !== "string" || ENDED_STATUSES[status] === undefined) return null;
  const stopped = typeof detail.stopDate === "number" ? new Date(detail.stopDate) : new Date(event.time);
  return {
    executionArn,
    status,
    at: Number.isNaN(stopped.valueOf()) ? new Date().toISOString() : stopped.toISOString(),
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof cause === "string" ? { cause } : {}),
  };
}
