import assert from "node:assert/strict";
import test from "node:test";

import { apiFailure, failureKind } from "../src/api/contract.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a route the API does not know is unavailable, not a failure", async () => {
  const error = await apiFailure(json(404, { error: "not_found" }), "Releases could not be loaded.");
  assert.equal(error.kind, "unavailable");
  assert.equal(error.message, "Releases could not be loaded.");
});

test("a resource that does not exist keeps its retry", async () => {
  // The route answered. Only the dispatcher's own body means "no such route".
  const error = await apiFailure(json(404, { error: "unknown_materialized_world" }), "The world is gone.");
  assert.equal(error.kind, "failed");
});

test("501 is unavailable without reading a body", async () => {
  const error = await apiFailure(new Response(null, { status: 501 }), "Not implemented.");
  assert.equal(error.kind, "unavailable");
});

test("403 is forbidden", async () => {
  const error = await apiFailure(json(403, { error: "forbidden" }), "Your role cannot read backups.");
  assert.equal(error.kind, "forbidden");
});

test("everything else stays a failure", async () => {
  for (const status of [400, 409, 500, 502]) {
    const error = await apiFailure(json(status, { error: "boom" }), "It broke.");
    assert.equal(error.kind, "failed", `status ${status}`);
  }
});

test("a body already read is classified without touching the response again", async () => {
  const response = json(404, { error: "not_found" });
  const body = await response.json() as { error?: unknown };
  const error = await apiFailure(response, "Backups could not be loaded.", body);
  assert.equal(error.kind, "unavailable");
});

test("anything that is not an ApiError counts as a plain failure", () => {
  assert.equal(failureKind(new Error("network")), "failed");
  assert.equal(failureKind(null), "failed");
});
