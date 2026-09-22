import assert from "node:assert/strict";
import test from "node:test";

import { buildLifecycleStartInput } from "../src/domain/telegram-bot.ts";

const base = { serverId: "minecraft", operationId: "op-1", sessionId: "session-1", instanceId: "i-1", worldId: "world", requestedBy: "owner" };

test("a start names its placement mode, and the default is the one that runs today", () => {
  assert.equal(buildLifecycleStartInput(base).placement, "single");
  assert.equal(buildLifecycleStartInput({ ...base, placement: "shared" }).placement, "shared");
  assert.equal(buildLifecycleStartInput({ ...base, placement: "fleet" }).placement, "fleet");
  assert.equal(buildLifecycleStartInput(base).launch, "disabled");
  assert.equal(buildLifecycleStartInput(base).appCommit, "main");
  assert.equal(buildLifecycleStartInput({ ...base, launch: "enabled", appCommit: "a".repeat(40) }).launch, "enabled");
});
