import "./support/browser.ts";

import assert from "node:assert/strict";
import { mock, test } from "node:test";

// `?operation=failed` seeds a promotion that ends at once with a long cause, so the UI gate can show a failure.

mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T12:00:00.000Z") });
(window as unknown as { location: { search: string } }).location.search = "?operation=failed";
const store = await import("../src/demo/store.ts");

test("the failed flag puts a promotion on the Creative world and ends it with the workflow's error and a long cause", () => {
  const [operation] = store.snapshot().operations;
  assert.deepEqual([operation?.type, operation?.worldId], ["promote", "minecraft-creative-5e1c9a07"]);
  assert.equal(store.operationProgress("minecraft", "minecraft-creative-5e1c9a07", operation!.id)!.status, "running");
  mock.timers.tick(1300);
  assert.equal(store.snapshot().operations.length, 0);
  const done = store.operationProgress("minecraft", "minecraft-creative-5e1c9a07", operation!.id)!;
  assert.equal(done.status, "failed");
  assert.equal(done.failure?.error, "Ec2.InsufficientInstanceCapacity");
  assert.ok((done.failure?.cause.length ?? 0) > 200);
  assert.equal(done.caught?.step?.key, "promote.starting_release");
});
