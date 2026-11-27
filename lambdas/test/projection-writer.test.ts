import assert from "node:assert/strict";
import test from "node:test";

import { writeProjection, type ProjectionWriterPorts, type StoredProjection } from "../src/control-plane/projection-writer.ts";
import type { OperationObservation } from "../src/control-plane/read-model.ts";

const ended = { id: "event-1", source: "aws.states", "detail-type": "Step Functions Execution Status Change", time: "2026-09-15T00:00:00.000Z", detail: { executionArn: "arn:a", status: "SUCCEEDED" } };
const stale: OperationObservation = { id: "a", type: "start", status: "running", startedAt: "2026-09-15T00:00:00.000Z", providerRef: "arn:a", worldId: "w1" };

function ports(refusals: number, log: string[]): ProjectionWriterPorts & { stored: StoredProjection[] } {
  let clock = 1_000;
  const stored: StoredProjection[] = [];
  return {
    stored,
    now: () => { log.push("now"); return clock += 10; },
    listHosts: async () => { log.push("hosts"); return []; },
    listRunningOperations: async () => { log.push("operations"); return [stale]; },
    describeRunningOperation: async () => null,
    putProjection: async (projection) => {
      log.push("put");
      if (refusals > 0) { refusals -= 1; return false; }
      stored.push(projection);
      return true;
    },
  };
}

test("the projection takes its time before the reads and drops the run its event ended", async () => {
  const log: string[] = [];
  const writer = ports(0, log);
  const result = await writeProjection(writer, ended);
  assert.equal(result.written, true);
  assert.deepEqual(result.operations, []);
  assert.equal(log[0], "now");
  assert.deepEqual(writer.stored.map((projection) => projection.observedAtEpochMilliseconds), [1_010]);
});

test("a refused write reads and writes again, and the write that lands is reported", async () => {
  const log: string[] = [];
  const writer = ports(2, log);
  const result = await writeProjection(writer, ended);
  assert.equal(result.written, true);
  assert.equal(log.filter((entry) => entry === "put").length, 3);
  assert.equal(log.filter((entry) => entry === "operations").length, 3);
  assert.equal(result.observedAtEpochMilliseconds, 1_030);
});

test("the writer gives up after three refusals and reports it", async () => {
  const log: string[] = [];
  const result = await writeProjection(ports(5, log), ended);
  assert.equal(result.written, false);
  assert.equal(log.filter((entry) => entry === "put").length, 3);
});
