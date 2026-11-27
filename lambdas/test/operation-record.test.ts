import assert from "node:assert/strict";
import test from "node:test";

import type { Table } from "../src/control-plane/dynamo-table.ts";
import { endOperationRecord } from "../src/control-plane/dynamo-operation-records.ts";
import {
  executionEndOf, operationIdOfExecution, operationIdOfKey, operationRecordKey, parseOperationRecord,
} from "../src/control-plane/operation-record.ts";

const ID = "panel-start-20261127T120000-aaaa1111";
const ARN = `arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-start-server-v2:${ID}`;

test("one key per operation, and only that shape reads back as an operation id", () => {
  assert.deepEqual(operationRecordKey(ID), { pk: `OPERATION#${ID}`, sk: "RECORD" });
  assert.equal(operationIdOfKey(operationRecordKey(ID)), ID);
  assert.equal(operationIdOfKey({ pk: `OPERATION#${ID}`, sk: "DYNAMIC" }), null);
  assert.equal(operationIdOfKey({ pk: "PROJECTION#CONTROL_PLANE", sk: "RECORD" }), null);
  assert.equal(operationIdOfKey({ pk: "OPERATION#", sk: "RECORD" }), null);
});

test("the record's id is the execution name", () => {
  assert.equal(operationIdOfExecution(ARN), ID);
  assert.equal(operationIdOfExecution("arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-start-server-v2"), null);
});

const STORED = {
  ...operationRecordKey(ID),
  operation_id: ID,
  execution_arn: ARN,
  type: "start",
  workflow: "start",
  status: "running",
  world_id: "prominence",
  root_id: ID,
  child_id: `${ID}-host-start`,
  step: "start.starting_server",
  host_instance_id: "i-0123456789abcdef0",
  command_id: "",
  started_at: "2026-11-27T12:00:00.000Z",
  updated_at: "2026-11-27T12:01:00.000Z",
  open_key: "open",
  expires_at: 1_767_182_400,
};

test("a stored record reads back with camelCase fields, and an empty string means none", () => {
  const record = parseOperationRecord(STORED);
  assert.equal(record?.operationId, ID);
  assert.equal(record?.step, "start.starting_server");
  assert.equal(record?.childId, `${ID}-host-start`);
  assert.equal(record?.commandId, null);
  assert.equal(record?.parentId, null);
  assert.equal(record?.caught, null);
});

test("a partial item is not a record: a write that came before its accepted one", () => {
  assert.equal(parseOperationRecord({ ...operationRecordKey(ID), step: "start.preparing", updated_at: "x" }), null);
  assert.equal(parseOperationRecord({ ...STORED, type: "reboot" }), null);
  assert.equal(parseOperationRecord({ ...STORED, operation_id: "another" }), null);
  assert.equal(parseOperationRecord({ ...STORED, child_id: ID })?.childId, null);
});

function recordingTable(fail?: string): Table & { calls: unknown[] } {
  const calls: unknown[] = [];
  const refuse = async () => { throw new Error("not used"); };
  return {
    calls,
    get: refuse, put: refuse, delete: refuse, query: refuse, scan: refuse, transact: refuse,
    update: async (input: unknown) => {
      calls.push(input);
      if (fail !== undefined) throw Object.assign(new Error(fail), { name: fail });
      return { Attributes: undefined };
    },
  } as unknown as Table & { calls: unknown[] };
}

const event = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "e-1", source: "aws.states", "detail-type": "Step Functions Execution Status Change", time: "2026-11-27T12:05:00Z",
  detail: { executionArn: ARN, status, ...extra },
});

test("an ended run ends its record only while the record still runs", async () => {
  const table = recordingTable();
  const end = executionEndOf(event("ABORTED", { stopDate: Date.parse("2026-11-27T12:04:00Z") }));
  assert.deepEqual(end, { executionArn: ARN, status: "ABORTED", at: "2026-11-27T12:04:00.000Z" });
  assert.equal(await endOperationRecord(table, "view", end!), true);
  const call = table.calls[0] as { Key: unknown; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  assert.deepEqual(call.Key, operationRecordKey(ID));
  assert.equal(call.ConditionExpression, "#status = :running");
  assert.equal(call.ExpressionAttributeValues[":status"], "aborted");
  assert.equal(call.ExpressionAttributeValues[":error"], "States.ABORTED");
});

test("the workflow's own end write wins, and a running run or another event changes nothing", async () => {
  assert.equal(await endOperationRecord(recordingTable("ConditionalCheckFailedException"), "view", executionEndOf(event("FAILED", { error: "Boom", cause: "why" }))!), false);
  assert.equal(executionEndOf(event("RUNNING")), null);
  assert.equal(executionEndOf({ id: "e-2", source: "aws.ec2", "detail-type": "EC2 Instance State-change Notification", time: "2026-11-27T12:05:00Z", detail: {} }), null);
  await assert.rejects(endOperationRecord(recordingTable("ThrottlingException"), "view", executionEndOf(event("TIMED_OUT"))!));
});
