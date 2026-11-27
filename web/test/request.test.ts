import "./support/browser.ts";

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { ApiError } from "../src/api/contract.ts";
import { request, requestOrNull } from "../src/api/live/request.ts";
import { failureView } from "../src/core/failure.ts";

function answer(status: number, json?: unknown) {
  mock.method(globalThis, "fetch", async () => new Response(json === undefined ? null : JSON.stringify(json), { status }));
}

async function failure(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof ApiError, "every failure is an ApiError");
    return error;
  }
  throw new Error("the call did not fail");
}

afterEach(() => { mock.restoreAll(); });

test("an ok answer is its parsed body", async () => {
  answer(200, { value: 3 });
  assert.deepEqual(await request<{ value: number }>("/x", { failure: "No." }), { value: 3 });
});

test("a refusal carries status, code, detail and the text of its code", async () => {
  answer(409, { error: "last_owner", name: "Ada" });
  const error = await failure(request("/x", { method: "POST", failure: "No." }));
  assert.equal(error.status, 409);
  assert.equal(error.code, "last_owner");
  assert.equal(error.detail?.name, "Ada");
  assert.equal(error.kind, "failed");
  assert.match(error.message, /last Owner/);
});

test("a call's own words for a code win over the shared text, and may read the detail", async () => {
  answer(409, { error: "last_owner", name: "Ada" });
  const error = await failure(request("/x", { failure: "No.", refusals: { last_owner: (detail) => `${String(detail.name)} is the last Owner.` } }));
  assert.equal(error.message, "Ada is the last Owner.");
});

test("a code with no text, or no body, falls back to the call's failure text", async () => {
  answer(400, { error: "something_new" });
  assert.equal((await failure(request("/x", { failure: "It broke." }))).message, "It broke.");
  mock.restoreAll();
  answer(502);
  assert.equal((await failure(request("/x", { failure: "It broke." }))).message, "It broke.");
});

test("403 is forbidden, and 501, 503 and a network failure are unavailable", async () => {
  answer(403, { error: "forbidden" });
  assert.equal((await failure(request("/x", { failure: "No." }))).kind, "forbidden");
  for (const status of [501, 503]) {
    mock.restoreAll();
    answer(status, {});
    assert.equal((await failure(request("/x", { failure: "No." }))).kind, "unavailable", `status ${status}`);
  }
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  const lost = await failure(request("/x", { failure: "No." }));
  assert.equal(lost.kind, "unavailable");
  assert.equal(lost.status, 0);
});

test("an ok answer that lacks what the call needs is a failure", async () => {
  answer(200, {});
  const error = await failure(request<{ url?: string }>("/x", { failure: "No link.", valid: (body) => body.url !== undefined }));
  assert.equal(error.message, "No link.");
});

test("requestOrNull turns only the accepted answer into null", async () => {
  answer(409, { error: "world_not_running" });
  assert.equal(await requestOrNull("/x", { failure: "No." }, (error) => error.status === 409), null);
  mock.restoreAll();
  answer(500, {});
  await failure(requestOrNull("/x", { failure: "No." }, (error) => error.status === 409));
});

test("a role without the permission has nothing to retry; an API that did not answer keeps Retry", () => {
  assert.deepEqual(failureView("forbidden", "Backups could not be loaded", "read backups", "x"), { kind: "forbidden", title: "Your role cannot read backups", message: null, retry: false });
  assert.deepEqual(failureView("unavailable", "Backups could not be loaded", "read backups", "No answer."), { kind: "unavailable", title: "Unavailable", message: "No answer.", retry: true });
  assert.equal(failureView("failed", "Backups could not be loaded", "read backups", "x").retry, true);
});

// ADR-0108: a start or an update refused for missing secrets names them.
test("a start refused for missing game secrets names the keys", async () => {
  const { worldsApi } = await import("../src/api/live/worlds.ts");
  answer(409, { error: "missing_game_secrets", keys: ["ZOMBOID_RCON_PASSWORD", "ZOMBOID_ADMIN_PASSWORD"] });
  const started = await failure(worldsApi.requestSessionOperation("zomboid", "world-a", "start"));
  assert.equal(started.code, "missing_game_secrets");
  assert.match(started.message, /ZOMBOID_RCON_PASSWORD, ZOMBOID_ADMIN_PASSWORD/);
  mock.restoreAll();
  answer(409, { error: "missing_game_secrets" });
  const promoted = await failure(worldsApi.requestPromotion("zomboid", "world-a", "1.2"));
  assert.doesNotMatch(promoted.message, /\{keys\}/);
});
