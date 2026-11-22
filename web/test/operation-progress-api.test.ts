import "./support/browser.ts";

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import type { OperationProgress } from "../src/api/contract.ts";
import { operationsApi } from "../src/api/live/operations.ts";

const body: OperationProgress = {
  id: "op/1", type: "promote", status: "running", startedAt: "2026-11-21T12:00:00.000Z", stoppedAt: null, elapsedSeconds: 3,
  step: { key: "promote.checking_release", label: "Checking the release" }, child: null, result: null, failure: null, caught: null,
};

let requested = "";
function answer(status: number, json: unknown = {}) {
  mock.method(globalThis, "fetch", async (url: string) => {
    requested = url;
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => { mock.restoreAll(); });

test("the progress call reads the world's operation by its encoded ids and returns the body as the API sent it", async () => {
  answer(200, body);
  assert.deepEqual(await operationsApi.loadOperationProgress("minecraft", "world 1", "op/1"), body);
  assert.match(requested, /\/games\/minecraft\/worlds\/world%201\/operations\/op%2F1$/);
});

test("an operation the API does not know reads as null, not as an error", async () => {
  answer(404, { error: "unknown_operation" });
  assert.equal(await operationsApi.loadOperationProgress("minecraft", "w1", "gone"), null);
});

test("any other refusal is an error with words for the role", async () => {
  answer(403, { error: "forbidden" });
  await assert.rejects(operationsApi.loadOperationProgress("minecraft", "w1", "op-1"), /role cannot read operations/);
  answer(500, {});
  await assert.rejects(operationsApi.loadOperationProgress("minecraft", "w1", "op-1"), /could not be read/);
});
