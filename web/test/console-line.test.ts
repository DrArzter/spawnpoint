import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { ConsoleEntry } from "../src/api/contract.ts";
import { consoleLine } from "../src/core/Console.tsx";

const entry: ConsoleEntry = {
  id: "c1", at: "2026-10-09T18:40:03.000Z", identityId: "identity-owner", displayName: "DrArzter",
  worldId: "minecraft-rostik-12345678", command: "list", status: "succeeded", output: "There are 0 players online",
};

test("a command typed in the panel names the person", () => {
  assert.equal(consoleLine(entry).who, "DrArzter");
  assert.equal(consoleLine({ ...entry, agent: null }).who, "DrArzter");
});

test("a command an agent sent names the person and the agent (ADR-0063)", () => {
  assert.equal(consoleLine({ ...entry, agent: "Claude" }).who, "DrArzter via Claude");
});
