import assert from "node:assert/strict";
import test from "node:test";

import { sessionChangeNotifier } from "../src/lifecycle/session-changes.ts";

test("a session change is published as an invalidation the subscriptions accept", async () => {
  const published: unknown[] = [];
  const notify = sessionChangeNotifier({ publish: async (event) => { published.push(event); return null; } }, { warn: () => {} }, () => 1_234);
  await notify("world#alpha");
  assert.deepEqual(published, [{ source: "spawnpoint.control-plane", detailType: "Session Changed", detail: { schemaVersion: 1, serverId: "world#alpha", observedAtEpochMilliseconds: 1_234 } }]);
});

test("a refused or failed publish is logged and never fails the record write", async () => {
  const warnings: unknown[][] = [];
  const log = { warn: (...args: unknown[]) => { warnings.push(args); } };
  await sessionChangeNotifier({ publish: async () => "throttled" }, log)("minecraft");
  await sessionChangeNotifier({ publish: async () => { throw new Error("offline"); } }, log)("minecraft");
  assert.equal(warnings.length, 2);
});
