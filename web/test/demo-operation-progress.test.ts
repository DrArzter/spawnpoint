import "./support/browser.ts";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import * as store from "../src/demo/store.ts";

// The demo's promotion walks the workflow's steps over its run, then reads as succeeded.

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T12:00:00.000Z") });

const GAME = "minecraft";
const CREATIVE = "minecraft-creative-5e1c9a07";

test("a promotion moves through its steps with time, the starting step holding its own child steps", () => {
  const creative = store.snapshot().games.find((item) => item.id === GAME)!.worlds.find((item) => item.id === CREATIVE)!;
  const to = creative.preset!.releases.at(-1)!;
  const { operationId } = store.promoteWorld(GAME, CREATIVE, to) as { operationId: string };
  const read = () => store.operationProgress(GAME, CREATIVE, operationId)!;
  const names = (progress: ReturnType<typeof read>) => [progress.step?.label ?? null, progress.child?.step.label ?? null];

  assert.deepEqual([read().status, read().type, read().expectedSeconds], ["running", "promote", 30]);
  assert.deepEqual(names(read()), ["Checking the release", null]);
  // A six second run split by the steps' weights.
  mock.timers.tick(500);
  assert.deepEqual(names(read()), ["Stopping the server", null]);
  mock.timers.tick(1000);
  assert.deepEqual(names(read()), ["Keeping the backup", null]);
  mock.timers.tick(1000);
  assert.deepEqual(names(read()), ["Starting on the new release", "Launching the host"]);
  assert.equal(read().step?.key, "promote.starting_release");
  assert.equal(read().child?.step.key, "start.launching_host");
  mock.timers.tick(1100);
  assert.deepEqual(names(read()), ["Starting on the new release", "Waiting for the host"]);
  mock.timers.tick(1100);
  assert.deepEqual(names(read()), ["Starting on the new release", "Starting the server"]);
  mock.timers.tick(900);
  assert.deepEqual(names(read()), ["Recording the release", null]);
  assert.equal(read().elapsedSeconds, 5);
});

test("when the operation leaves the snapshot it reads as succeeded with no step, and another world's id reads as unknown", () => {
  const [operation] = store.snapshot().operations;
  assert.ok(operation);
  mock.timers.tick(500);
  assert.equal(store.snapshot().operations.length, 0);
  const done = store.operationProgress(GAME, CREATIVE, operation.id)!;
  assert.deepEqual([done.status, done.step, done.child, done.result, done.failure, done.elapsedSeconds], ["succeeded", null, null, "promoted", null, 6]);
  assert.ok(done.stoppedAt);
  assert.equal(store.operationProgress(GAME, "vanilla", operation.id), null);
  assert.equal(store.operationProgress(GAME, CREATIVE, "op-missing"), null);
});

test("a demo start prints the host's lines over its run, oldest first", () => {
  const { operationId } = store.startSession("minecraft", "minecraft-sandbox-8d41f0b6");
  const lines = () => store.operationProgress("minecraft", "minecraft-sandbox-8d41f0b6", operationId)!.hostLog!;
  assert.equal(lines().length, 1);
  mock.timers.tick(5000);
  const mid = lines();
  assert.ok(mid.length > 1 && mid.length < 9);
  assert.deepEqual(mid.map((line) => line.at), [...mid.map((line) => line.at)].sort());
  assert.ok(mid.every((line) => line.text.length > 0 && line.text.length <= 200));
});
