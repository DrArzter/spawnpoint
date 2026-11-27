// The operation records in DynamoDB (ADR-0105): the readers' store, and the
// projector's one write, which ends a record whose run ended without the
// workflow's own end write.

import type { Table } from "./dynamo-table.ts";
import {
  ENDED_STATUSES, MAX_RECORD_TEXT, OPEN_KEY_VALUE, OPEN_OPERATIONS_INDEX, operationIdOfExecution, operationRecordKey, parseOperationRecord,
  type ExecutionEnd, type OperationRecord,
} from "./operation-record.ts";
import type { OperationRecordStore } from "./operation-record-progress.ts";

/** The record store over the view table: one consistent read by id, and the running ones from the sparse index. */
export function dynamoOperationRecordStore(table: Table, tableName: string): OperationRecordStore {
  return {
    async get(operationId) {
      const read = await table.get({ TableName: tableName, Key: operationRecordKey(operationId), ConsistentRead: true });
      return parseOperationRecord(read.Item);
    },
    async listOpen() {
      const records: OperationRecord[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await table.query({
          TableName: tableName,
          IndexName: OPEN_OPERATIONS_INDEX,
          KeyConditionExpression: "#open_key = :open",
          ExpressionAttributeNames: { "#open_key": "open_key" },
          ExpressionAttributeValues: { ":open": OPEN_KEY_VALUE },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        });
        for (const item of page.Items ?? []) {
          const record = parseOperationRecord(item);
          if (record !== null) records.push(record);
        }
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return records;
    },
  };
}

/**
 * Ends a record whose run ended without its own end write: aborted, timed out,
 * or failed with an error no Catch handled. Only a record that still runs is
 * changed, so the workflow's own end write always wins. False when nothing
 * changed: no record, or one that had already ended.
 */
export async function endOperationRecord(table: Table, tableName: string, end: ExecutionEnd): Promise<boolean> {
  const status = ENDED_STATUSES[end.status];
  const operationId = operationIdOfExecution(end.executionArn);
  if (status === undefined || operationId === null) return false;
  try {
    await table.update({
      TableName: tableName,
      Key: operationRecordKey(operationId),
      ConditionExpression: "#status = :running",
      UpdateExpression: "SET #status = :status, #error = :error, #cause = :cause, #ended_at = :at, #updated_at = :at REMOVE #open_key",
      ExpressionAttributeNames: {
        "#status": "status", "#error": "error", "#cause": "cause", "#ended_at": "ended_at", "#updated_at": "updated_at", "#open_key": "open_key",
      },
      ExpressionAttributeValues: {
        ":running": "running",
        ":status": status,
        ":error": (end.error ?? (status === "succeeded" ? "" : `States.${end.status}`)).slice(0, MAX_RECORD_TEXT),
        ":cause": (end.cause ?? "").slice(0, MAX_RECORD_TEXT),
        ":at": end.at,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
