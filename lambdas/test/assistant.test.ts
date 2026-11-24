import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { AccessTable } from "../src/access/table.ts";
import {
  ASSISTANT_DAILY_LIMIT, type AssistantAnswer, type AssistantAnswers, type AssistantBudget, type AssistantJob, type AssistantOutcome,
  type AssistantRecord, assistantConfigFromEnv, assistantPrompt, costMicroUsd, runAssistantJob,
} from "../src/control-plane/assistant.ts";
import { tableAssistantAnswers, tableAssistantBudget } from "../src/control-plane/assistant-store.ts";
import type { WorldLogRead } from "../src/control-plane/world-log.ts";
import { assistantFeature } from "../src/handlers/api/assistant.ts";
import { capabilitiesForRoutes } from "../src/handlers/api/capabilities.ts";

// The owner's log assistant (ADR-0094): its settings, limits, job and stores,
// against fakes. No model is called.

const env = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_MONTHLY_CAP_USD: "5",
  ASSISTANT_HAIKU_MODEL_ID: "eu.anthropic.claude-haiku-5-5",
  ASSISTANT_SONNET_MODEL_ID: "eu.anthropic.claude-sonnet-5-5",
  ASSISTANT_PRICES: JSON.stringify({ haiku: { input: 0.1, output: 0.5 }, sonnet: { input: 2, output: 10 } }),
};

test("the assistant is on only when switched on and fully set", () => {
  const config = assistantConfigFromEnv(env);
  assert.equal(config.enabled, true);
  assert.equal(config.monthlyCapUsd, 5);
  assert.deepEqual(config.prices.sonnet, { input: 2, output: 10 });
  assert.equal(assistantConfigFromEnv({ ...env, ASSISTANT_ENABLED: "false" }).enabled, false);
  assert.equal(assistantConfigFromEnv({ ...env, ASSISTANT_PRICES: "{}" }).enabled, false, "a missing price turns it off");
  assert.equal(assistantConfigFromEnv({ ...env, ASSISTANT_PRICES: "not json" }).enabled, false);
  assert.equal(assistantConfigFromEnv({ ...env, ASSISTANT_MONTHLY_CAP_USD: "0" }).enabled, false, "no cap, no assistant");
  assert.equal(assistantConfigFromEnv({ ...env, ASSISTANT_SONNET_MODEL_ID: "" }).enabled, false);
  assert.equal(assistantConfigFromEnv({}).enabled, false);
});

test("an answer costs its tokens at the model's price, in millionths of a dollar", () => {
  assert.equal(costMicroUsd({ inputTokens: 1000, outputTokens: 500 }, { input: 2, output: 10 }), 7000);
  assert.equal(costMicroUsd({ inputTokens: 3, outputTokens: 1 }, { input: 0.1, output: 0.5 }), 1, "a fraction rounds up");
});

test("the prompt keeps the log between tags and asks a default question", () => {
  const prompt = assistantPrompt("Minecraft", ["a", "b"], null);
  assert.match(prompt, /^Game: Minecraft\n\n<log>\na\nb\n<\/log>\n\nQuestion: What is wrong/);
  assert.match(assistantPrompt("Minecraft", [], "Why the lag?"), /Question: Why the lag\?$/);
});

const job: AssistantJob = { worldId: "world-a", answerId: "answer-1", model: "sonnet", gameName: "Game A", lines: ["x"], question: null };

test("a job stores the answer and adds its cost to the month", async () => {
  const settled: AssistantOutcome[] = [];
  const spent: [string, number][] = [];
  const outcome = await runAssistantJob(job, {
    model: { answer: async (request) => { assert.equal(request.modelId, "eu.anthropic.claude-sonnet-5-5"); return { text: " fine \n", usage: { inputTokens: 1000, outputTokens: 100 } }; } },
    answers: { settle: async (_world, _id, result) => { settled.push(result); } },
    budget: { addSpend: async (month, cost) => { spent.push([month, cost]); } },
    config: assistantConfigFromEnv(env),
    now: () => new Date("2026-11-24T12:00:00Z"),
  });
  assert.deepEqual(outcome, { status: "succeeded", text: "fine", usage: { inputTokens: 1000, outputTokens: 100 }, costMicroUsd: 3000 });
  assert.deepEqual(settled, [outcome]);
  assert.deepEqual(spent, [["2026-11", 3000]]);
});

test("a job whose model fails is settled as failed and spends nothing", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const settled: AssistantOutcome[] = [];
  const outcome = await runAssistantJob(job, {
    model: { answer: async () => { throw new Error("throttled"); } },
    answers: { settle: async (_world, _id, result) => { settled.push(result); } },
    budget: { addSpend: async () => { throw new Error("nothing is spent"); } },
    config: assistantConfigFromEnv(env),
    now: () => new Date(),
  });
  assert.deepEqual(outcome, { status: "failed" });
  assert.deepEqual(settled, [{ status: "failed" }]);
});

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const ready: WorldLogRead = { id: "read-1", at: "2026-11-24T11:59:00Z", status: "succeeded", lines: ["player-1 joined the game"] };

function fakes(options: { enabled?: boolean; read?: WorldLogRead | null; spent?: number; used?: number; workerFails?: boolean } = {}) {
  const created: AssistantRecord[] = [];
  const settled: { answerId: string; outcome: AssistantOutcome }[] = [];
  const jobs: AssistantJob[] = [];
  let used = options.used ?? 0;
  const answers: AssistantAnswers = {
    create: async (record) => { created.push(record); },
    find: async (_game, _world, answerId) => created.find((record) => record.answer.id === answerId)?.answer ?? null,
    settle: async (_world, answerId, outcome) => { settled.push({ answerId, outcome }); },
  };
  const budget: AssistantBudget = {
    claimDailyUse: async (_identity, _day, limit) => (used < limit ? (used += 1, true) : false),
    monthlySpend: async () => options.spent ?? 0,
    addSpend: async () => undefined,
  };
  const feature = assistantFeature({
    config: { enabled: options.enabled ?? true, monthlyCapUsd: 5 },
    logRead: async (_game, _world, readId) => (readId === "read-1" ? (options.read === undefined ? ready : options.read) : null),
    gameName: (gameId) => (gameId === "game-a" ? "Game A" : null),
    answers,
    budget,
    worker: { start: async (started) => { if (options.workerFails) throw new Error("no worker"); jobs.push(started); } },
    newId: () => "answer-1",
    now: () => new Date("2026-11-24T12:00:00.000Z"),
  });
  return { feature, created, settled, jobs, used: () => used };
}

const ask = (body: unknown) => JSON.stringify(body);
const errorOf = (response: { body: string }) => (JSON.parse(response.body) as { error?: string }).error;

test("a question is recorded and handed to the worker with the redacted log", async () => {
  const { feature, created, jobs } = fakes();
  const response = await feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "haiku", question: "  Why?  " }));
  assert.equal(response.statusCode, 202);
  const answer: AssistantAnswer = { id: "answer-1", at: "2026-11-24T12:00:00.000Z", logReadId: "read-1", model: "haiku", question: "Why?", status: "pending", text: null };
  assert.deepEqual((JSON.parse(response.body) as { answer: AssistantAnswer }).answer, answer);
  assert.deepEqual(created, [{ answer, gameId: "game-a", worldId: "world-a", identityId: "identity-1" }]);
  assert.deepEqual(jobs, [{ worldId: "world-a", answerId: "answer-1", model: "haiku", gameName: "Game A", lines: ready.lines, question: "Why?" }]);
  assert.equal((await feature.answer("game-a", "world-a", "answer-1")).statusCode, 200);
  assert.equal(errorOf(await feature.answer("game-a", "world-a", "answer-2")), "unknown_assistant_answer");
});

test("a switched-off assistant refuses before anything is counted", async () => {
  const { feature, used } = fakes({ enabled: false });
  const response = await feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "haiku" }));
  assert.deepEqual([response.statusCode, errorOf(response)], [409, "assistant_disabled"]);
  assert.equal(used(), 0);
});

test("a malformed question is refused", async () => {
  const { feature } = fakes();
  for (const body of [{ model: "haiku" }, { logReadId: "read-1", model: "opus" }, { logReadId: "read-1", model: "haiku", question: 7 },
    { logReadId: "read-1", model: "haiku", question: "x".repeat(501) }, { logReadId: "read-1", model: "haiku", question: "tab\there" }]) {
    assert.equal(errorOf(await feature.ask(owner, "game-a", "world-a", ask(body))), "invalid_assistant_request", JSON.stringify(body));
  }
  assert.equal((await feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "haiku", question: "line one\nline two" }))).statusCode, 202);
});

test("a question needs a finished log read of the world", async () => {
  assert.equal(errorOf(await fakes().feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-9", model: "haiku" }))), "unknown_log_read");
  assert.equal(errorOf(await fakes().feature.ask(owner, "game-z", "world-a", ask({ logReadId: "read-1", model: "haiku" }))), "unknown_world");
  const pending = fakes({ read: { ...ready, status: "pending", lines: null } });
  assert.equal(errorOf(await pending.feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "haiku" }))), "log_not_ready");
});

test("the month's cap is checked before the day's question is counted", async () => {
  const capped = fakes({ spent: 5_000_000 });
  const response = await capped.feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "sonnet" }));
  assert.deepEqual([response.statusCode, errorOf(response)], [429, "assistant_monthly_limit"]);
  assert.equal(capped.used(), 0);
  const busy = fakes({ used: ASSISTANT_DAILY_LIMIT });
  assert.equal(errorOf(await busy.feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "sonnet" }))), "assistant_daily_limit");
  assert.equal(busy.created.length, 0);
});

test("an answer whose worker did not start is settled as failed", async () => {
  const { feature, settled } = fakes({ workerFails: true });
  await assert.rejects(feature.ask(owner, "game-a", "world-a", ask({ logReadId: "read-1", model: "haiku" })), /no worker/);
  assert.deepEqual(settled, [{ answerId: "answer-1", outcome: { status: "failed" } }]);
});

function recordingTable(fail: (kind: string) => boolean = () => false) {
  const calls: { kind: string; input: Record<string, unknown> }[] = [];
  const conditionFailed = Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
  const record = (kind: string) => async (input: unknown) => {
    calls.push({ kind, input: input as Record<string, unknown> });
    if (fail(kind)) throw conditionFailed;
    return {};
  };
  const table: AccessTable = {
    get: async (input) => { calls.push({ kind: "get", input: input as Record<string, unknown> }); return {}; },
    put: record("put"), update: record("update"), delete: record("delete"),
    query: async () => ({}), scan: async () => ({}), transact: record("transact"),
  };
  return { table, calls };
}

test("an answer is stored under its world with a week's expiry, and settled once", async () => {
  const { table, calls } = recordingTable((kind) => kind === "update");
  const answers = tableAssistantAnswers(table, "access");
  const answer: AssistantAnswer = { id: "answer-1", at: "2026-11-24T12:00:00.000Z", logReadId: "read-1", model: "haiku", question: null, status: "pending", text: null };
  await answers.create({ answer, gameId: "game-a", worldId: "world-a", identityId: "identity-1" });
  const item = calls[0]!.input.Item as Record<string, unknown>;
  assert.deepEqual([item.pk, item.sk, item.model, item.status, item.ttl, "question" in item], ["ASSISTANT#world-a", "answer-1", "haiku", "pending", Date.parse("2026-12-01T12:00:00.000Z") / 1000, false]);
  await answers.settle("world-a", "answer-1", { status: "failed" });
  assert.equal(calls[1]!.input.ConditionExpression, "#status = :pending", "a settled answer is not settled again");
});

test("the day's count stops at its limit and the month's spend adds up", async () => {
  const full = recordingTable((kind) => kind === "update");
  assert.equal(await tableAssistantBudget(full.table, "access").claimDailyUse("identity-1", "2026-11-24", 20), false);
  const open = recordingTable();
  const budget = tableAssistantBudget(open.table, "access", () => new Date("2026-11-24T12:00:00Z"));
  assert.equal(await budget.claimDailyUse("identity-1", "2026-11-24", 20), true);
  assert.deepEqual(open.calls[0]!.input.Key, { pk: "ASSISTANT_USE#identity-1", sk: "2026-11-24" });
  assert.equal((open.calls[0]!.input.ExpressionAttributeValues as Record<string, unknown>)[":limit"], 20);
  await budget.addSpend("2026-11", 3000);
  assert.deepEqual(open.calls[1]!.input.Key, { pk: "ASSISTANT_SPEND", sk: "2026-11" });
  assert.match(String(open.calls[1]!.input.UpdateExpression), /ADD micro_usd :cost/);
  assert.equal(await budget.monthlySpend("2026-11"), 0);
});

test("a switched-off capability is not advertised although its route exists", () => {
  const routes = { "POST /games/{gameId}/worlds/{worldId}/assistant": 1, "POST /games/{gameId}/worlds/{worldId}/log": 1 };
  assert.deepEqual(capabilitiesForRoutes(routes), ["worldLog", "assistant"]);
  assert.deepEqual(capabilitiesForRoutes(routes, new Set(["assistant"])), ["worldLog"]);
});
