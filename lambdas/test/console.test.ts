import assert from "node:assert/strict";
import test from "node:test";

import { CONSOLE_OUTPUT_LIMIT, checkConsoleCommand, consoleEntryFromItem, consoleResult, encodeConsoleCommand } from "../src/control-plane/console.ts";

// The console gateway (ADR-0063): what an operator may type, and what the
// host's answer means.

test("a command is one line of text, at most 256 characters, trimmed", () => {
  assert.deepEqual(checkConsoleCommand("minecraft", "  say hello  "), { ok: true, command: "say hello" });
  assert.deepEqual(checkConsoleCommand("minecraft", "x".repeat(256)), { ok: true, command: "x".repeat(256) });
  for (const raw of ["", "   ", "x".repeat(257), "list\nstop", "say\ttab", "say \u0007bell", 42, null, undefined]) {
    assert.deepEqual(checkConsoleCommand("minecraft", raw), { ok: false, reason: "invalid_command" }, JSON.stringify(raw));
  }
  assert.equal(checkConsoleCommand("minecraft", "say привет, мир").ok, true, "a line in any language is text");
});

test("a command that stops the game outside its lifecycle is refused, per game", () => {
  for (const raw of ["stop", "/stop", "STOP", "save-off", "stop now"]) {
    assert.deepEqual(checkConsoleCommand("minecraft", raw), { ok: false, reason: "lifecycle_command" }, raw);
  }
  assert.deepEqual(checkConsoleCommand("factorio", "/quit"), { ok: false, reason: "lifecycle_command" });
  assert.deepEqual(checkConsoleCommand("zomboid", "quit"), { ok: false, reason: "lifecycle_command" });
  for (const raw of ["shutdown", "shutdown 30", "Stop", "/stop"]) {
    assert.deepEqual(checkConsoleCommand("palworld", raw), { ok: false, reason: "lifecycle_command" }, raw);
  }
  for (const [game, raw] of [["minecraft", "say stop"], ["minecraft", "save-all flush"], ["minecraft", "stopsound @a"], ["factorio", "/players online"], ["zomboid", "players"], ["factorio", "stop"], ["valheim", "save"], ["palworld", "save"], ["palworld", "announce Server stops soon"], ["palworld", "metrics"]] as const) {
    assert.equal(checkConsoleCommand(game, raw).ok, true, `${game}: ${raw}`);
  }
});

test("the command travels as base64, so the host's shell never reads it", () => {
  const hostile = "say $(touch /tmp/x); `id` 'quote\" ok";
  const encoded = encodeConsoleCommand(hostile);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), hostile);
  assert.ok(encodeConsoleCommand("ж".repeat(256)).length <= 1400, "the longest command fits the document's pattern");
});

test("an invocation reads as the console's own status", () => {
  const invocation = (status: string, responseCode: number | null, output = "", error = "") => ({ status, responseCode, output, error });
  assert.deepEqual(consoleResult(invocation("InProgress", null)), { status: "pending", output: null });
  assert.deepEqual(consoleResult(invocation("Pending", null)), { status: "pending", output: null });
  assert.deepEqual(consoleResult(invocation("Success", 0, "There are 2 of a max of 20 players online: Alice, Bob\n")), { status: "succeeded", output: "There are 2 of a max of 20 players online: Alice, Bob" });
  assert.deepEqual(consoleResult(invocation("Failed", 3, "Error: rcon connection refused\n")), { status: "failed", output: "Error: rcon connection refused" });
  assert.deepEqual(consoleResult(invocation("Failed", 9, "This host has no console script yet. Update its checkout.")).status, "unavailable");
  assert.deepEqual(consoleResult(invocation("Failed", 4, "", "error: factorio has no console")), { status: "unavailable", output: "error: factorio has no console" });
  assert.deepEqual(consoleResult(invocation("TimedOut", null)), { status: "timed_out", output: null });
  const long = consoleResult(invocation("Success", 0, "x".repeat(CONSOLE_OUTPUT_LIMIT + 50)));
  assert.equal(long.output?.length, CONSOLE_OUTPUT_LIMIT + 2, "a long reply is clipped and says so");
});

test("a recorded command names the agent it came through, and none from the panel", () => {
  const item = {
    command_id: "c1", created_at: "2026-10-09T18:40:03.000Z", identity_id: "identity-owner", display_name: "DrArzter",
    world_id: "minecraft-rostik-12345678", command: "list", status: "succeeded", output: "There are 0 players online",
  };
  assert.equal(consoleEntryFromItem(item).agent, null);
  const fromAgent = consoleEntryFromItem({ ...item, agent_client_id: "client-123456", agent_name: "Claude" });
  assert.equal(fromAgent.agent, "Claude");
  assert.equal(fromAgent.displayName, "DrArzter");
  assert.equal(consoleEntryFromItem({ ...item, status: undefined }).status, "pending");
});

test("the record store answers a deleted person's command with no name", async (t) => {
  process.env.ACCESS_TABLE_NAME ??= "access-api-test";
  const { accessTable } = await import("./access-table.ts");
  const { document } = await import("../src/handlers/api/access-store.ts");
  const { awsConsoleRecords } = await import("../src/handlers/api/console-store.ts");
  const record = {
    pk: "CONSOLE#minecraft-rostik-12345678", command_id: "c1", identity_id: "identity-gone", game_id: "minecraft",
    world_id: "minecraft-rostik-12345678", command: "list", status: "succeeded", output: "There are 0 players online",
  };
  accessTable(t, document, [
    { ...record, sk: "2026-10-09T18:40:03.000Z#c1", created_at: "2026-10-09T18:40:03.000Z" },
    { ...record, sk: "2026-10-09T18:41:03.000Z#c2", command_id: "c2", identity_id: "identity-owner", display_name: "DrArzter" },
  ]);
  const entries = (await awsConsoleRecords.recent("minecraft", "minecraft-rostik-12345678", 30)).map(({ entry }) => entry);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.identityId, entry.displayName]).sort(), [
    ["c1", "identity-gone", null], ["c2", "identity-owner", "DrArzter"],
  ]);
});
