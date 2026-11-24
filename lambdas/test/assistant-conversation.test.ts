import "./support/api-environment.ts";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import { assistantConfigFromEnv, type AssistantBudget } from "../src/control-plane/assistant.ts";
import {
  type AgentTool, type Block, type Conversation, type ConversePort, type ConverseReply, conversationView, MAX_TOOL_ROUNDS, resumeMessage,
  runTurn, type TurnDependencies,
} from "../src/control-plane/assistant-conversation.ts";
import { conversationsFeature } from "../src/handlers/api/assistant-conversations.ts";
import { response } from "../src/handlers/api/http.ts";

const { deployedTools } = await import("../src/handlers/api/route-table.ts");
const { assistantToolsJson } = await import("../src/handlers/api/tool-catalogue.ts");
const { answerAssistantRead, isAssistantToolRequest } = await import("../src/handlers/api/assistant-reads.ts");

// Conversations with the owner's assistant (ADR-0096): the tool loop against a
// fake model, proposals, and the API's turns. No model is called.

const config = assistantConfigFromEnv({
  ASSISTANT_ENABLED: "true", ASSISTANT_MONTHLY_CAP_USD: "5",
  ASSISTANT_HAIKU_MODEL_ID: "eu.anthropic.claude-haiku-5-5", ASSISTANT_SONNET_MODEL_ID: "eu.anthropic.claude-sonnet-5-5",
  ASSISTANT_PRICES: JSON.stringify({ haiku: { input: 1, output: 1 }, sonnet: { input: 2, output: 10 } }),
});
const tools: readonly AgentTool[] = [
  { name: "get_control_plane", title: "Get control plane", description: "Read everything.", inputSchema: {}, effect: "read", destructive: false },
  { name: "start_world", title: "Start world", description: "Start one world.", inputSchema: {}, effect: "write", destructive: false },
];
const owner: Identity = { id: "00000000-0000-4000-8000-000000000001", displayName: "Owner", roleId: "owner", directGrants: [] };

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1", identityId: owner.id, title: "Start it", model: "haiku", status: "working", note: null,
    messages: [{ role: "user", content: [{ text: "Start Rostik" }] }], proposals: [], held: [],
    createdAt: "2026-11-24T12:00:00.000Z", updatedAt: "2026-11-24T12:00:00.000Z", version: 2, ...overrides,
  };
}

const use = (toolUseId: string, name: string, input: unknown = {}): Block => ({ toolUse: { toolUseId, name, input } });

function scripted(replies: readonly ConverseReply[]): ConversePort & { calls: number } {
  const queue = [...replies];
  const port = { calls: 0, converse: async () => { port.calls += 1; return queue.shift() ?? { content: [{ text: "done" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  return port;
}

function deps(model: ConversePort, spent = 0): TurnDependencies & { reads: string[]; added: number[] } {
  const reads: string[] = [];
  const added: number[] = [];
  let ids = 0;
  return {
    model, tools, config, reads, added,
    read: async (_identity, tool) => { reads.push(tool); return { ok: true, text: `{"tool":"${tool}"}` }; },
    monthlySpend: async () => spent + added.reduce((sum, cost) => sum + cost, 0),
    addSpend: async (_month, cost) => { added.push(cost); },
    newId: () => `p${(ids += 1)}`,
    now: () => new Date("2026-11-24T12:01:00.000Z"),
  };
}

const usage = { inputTokens: 100, outputTokens: 10 };

test("reads run at once, as the owner, and the loop goes on until the model answers", async () => {
  const model = scripted([
    { content: [{ reasoning: { text: "Look first", signature: "sig" } }, use("t1", "get_control_plane")], stopReason: "tool_use", usage },
    { content: [{ text: "Rostik is running." }], stopReason: "end_turn", usage },
  ]);
  const d = deps(model);
  const next = await runTurn(conversation(), d);
  assert.equal(next.status, "idle");
  assert.deepEqual(d.reads, ["get_control_plane"]);
  assert.deepEqual(d.added, [110, 110], "each call's cost goes to the month");
  assert.deepEqual(next.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(next.messages[1]!.content[0], { reasoning: { text: "Look first", signature: "sig" } }, "reasoning is kept as it came");
  assert.deepEqual(next.messages[2]!.content, [{ toolResult: { toolUseId: "t1", ok: true, text: '{"tool":"get_control_plane"}' } }]);
});

test("a write never runs: it becomes a proposal, and the turn waits with its reads held", async () => {
  const model = scripted([{ content: [use("t1", "get_control_plane"), use("t2", "start_world", { gameId: "minecraft", worldId: "w" })], stopReason: "tool_use", usage }]);
  const d = deps(model);
  const next = await runTurn(conversation(), d);
  assert.equal(next.status, "waiting");
  assert.deepEqual(d.reads, ["get_control_plane"], "only the read ran");
  assert.deepEqual(next.proposals.map((proposal) => [proposal.tool, proposal.status, proposal.arguments]), [["start_world", "pending", { gameId: "minecraft", worldId: "w" }]]);
  assert.deepEqual(next.held.map((held) => held.toolUseId), ["t1"]);
  assert.equal(resumeMessage(next), null, "nothing goes on while a proposal waits");
  const decided = { ...next, proposals: next.proposals.map((proposal) => ({ ...proposal, status: "applied" as const, result: '{"result":"requested"}' })) };
  assert.deepEqual(resumeMessage(decided)?.content, [
    { toolResult: { toolUseId: "t1", ok: true, text: '{"tool":"get_control_plane"}' } },
    { toolResult: { toolUseId: "t2", ok: true, text: 'The Owner applied this. The route answered: {"result":"requested"}' } },
  ]);
});

test("an unknown tool is answered as an error, and the loop stops after its rounds or at the month's cap", async () => {
  const looping = scripted(Array.from({ length: MAX_TOOL_ROUNDS + 2 }, (_, index) => ({ content: [use(`t${index}`, "no_such_tool")], stopReason: "tool_use", usage })));
  const next = await runTurn(conversation(), deps(looping));
  assert.equal(looping.calls, MAX_TOOL_ROUNDS);
  assert.match(next.note ?? "", /stopped after 8 steps/);
  assert.match(JSON.stringify(next.messages[2]), /There is no tool named no_such_tool/);
  const capped = scripted([]);
  const stopped = await runTurn(conversation(), deps(capped, 5_000_000));
  assert.deepEqual([capped.calls, stopped.status], [0, "failed"]);
});

test("the panel is shown the words, the reads and the proposals, and no reasoning", () => {
  const view = conversationView(conversation({
    status: "waiting",
    messages: [
      { role: "user", content: [{ text: "Start Rostik" }] },
      { role: "assistant", content: [{ reasoning: { text: "secret" } }, { text: "Reading first." }, use("t1", "get_control_plane"), use("t2", "start_world")] },
    ],
    held: [{ toolUseId: "t1", ok: true, text: "{}" }],
    proposals: [{ id: "p1", toolUseId: "t2", tool: "start_world", title: "Start world", destructive: false, arguments: {}, status: "pending", result: null, decidedAt: null }],
  }), tools);
  assert.deepEqual(view.entries.map((entry) => entry.kind), ["owner", "assistant", "read", "proposal"]);
  assert.doesNotMatch(JSON.stringify(view), /secret|toolUseId/);
});

function store(initial: Conversation | null) {
  let stored = initial;
  const writes: Conversation[] = [];
  return {
    writes, current: () => stored,
    port: {
      list: async () => [], read: async () => stored,
      create: async (next: Conversation) => { stored = next; writes.push(next); },
      replace: async (next: Conversation) => { if (stored && next.version !== stored.version + 1) return false; stored = next; writes.push(next); return true; },
    },
  };
}

function feature(initial: Conversation | null, budget: Partial<AssistantBudget> = {}, ran: string[] = []) {
  const s = store(initial);
  const turns: string[] = [];
  const f = conversationsFeature({
    config: { enabled: true, monthlyCapUsd: 5 },
    store: s.port,
    budget: { claimDailyUse: async () => true, monthlySpend: async () => 0, addSpend: async () => undefined, ...budget },
    startTurn: async (_identity, id) => { turns.push(id); },
    runWrite: async (_identity, tool) => { ran.push(tool); return response(202, { result: "requested" }); },
    tools: () => tools,
    newId: () => "c-new",
    now: () => new Date("2026-11-24T12:02:00.000Z"),
  });
  return { f, s, turns, ran };
}

test("a new conversation is recorded and its turn handed to the worker", async () => {
  const { f, s, turns } = feature(null);
  const created = await f.create(owner, JSON.stringify({ model: "sonnet", message: "Start Rostik please" }));
  assert.equal(created.statusCode, 202);
  assert.deepEqual([s.current()?.status, s.current()?.model, s.current()?.title], ["working", "sonnet", "Start Rostik please"]);
  assert.deepEqual(turns, ["c-new"]);
  assert.equal((await f.create(owner, JSON.stringify({ message: "no model" }))).statusCode, 400);
  const capped = feature(null, { monthlySpend: async () => 5_000_000, claimDailyUse: async () => { throw new Error("the day is not counted"); } });
  assert.equal((await capped.f.create(owner, JSON.stringify({ model: "haiku", message: "x" }))).statusCode, 429);
});

test("a message waits for the turn and the proposals before it", async () => {
  for (const status of ["working", "waiting"] as const) {
    assert.equal((await feature(conversation({ status })).f.send(owner, "c1", JSON.stringify({ message: "and?" }))).statusCode, 409);
  }
  const { f, s, turns } = feature(conversation({ status: "idle" }));
  assert.equal((await f.send(owner, "c1", JSON.stringify({ message: "and?", model: "sonnet" }))).statusCode, 202);
  assert.deepEqual([s.current()?.status, s.current()?.model, s.current()?.version, turns], ["working", "sonnet", 3, ["c1"]]);
});

test("a proposal runs only when the owner applies it, and the turn goes on once every one is decided", async () => {
  const waiting = conversation({
    status: "waiting",
    messages: [{ role: "user", content: [{ text: "Start both" }] }, { role: "assistant", content: [use("t1", "start_world"), use("t2", "start_world")] }],
    proposals: [
      { id: "p1", toolUseId: "t1", tool: "start_world", title: "Start world", destructive: false, arguments: { gameId: "g", worldId: "a" }, status: "pending", result: null, decidedAt: null },
      { id: "p2", toolUseId: "t2", tool: "start_world", title: "Start world", destructive: false, arguments: { gameId: "g", worldId: "b" }, status: "pending", result: null, decidedAt: null },
    ],
  });
  const { f, s, turns, ran } = feature(waiting);
  assert.equal((await f.apply(owner, "c1", "p1")).statusCode, 200);
  assert.deepEqual([ran, turns, s.current()?.status], [["start_world"], [], "waiting"]);
  assert.equal((await f.apply(owner, "c1", "p1")).statusCode, 409, "a decided proposal is not run again");
  assert.equal((await f.reject(owner, "c1", "p2")).statusCode, 202);
  assert.deepEqual([ran, turns, s.current()?.status], [["start_world"], ["c1"], "working"]);
  assert.match(JSON.stringify(s.current()?.messages.at(-1)), /The Owner applied this.*The Owner rejected this proposal/);
  assert.equal((await f.apply(owner, "c1", "p9")).statusCode, 404);
});

test("the worker's read runs only a read tool, for an identity that still holds assistant.use", async () => {
  const request = { kind: "spawnpoint.assistant-tool", identityId: owner.id, tool: "get_control_plane", arguments: {} };
  assert.equal(isAssistantToolRequest(request), true);
  assert.equal(isAssistantToolRequest({ ...request, requestContext: {} }), false, "an HTTP event never takes this shape");
  const catalogue = deployedTools();
  const viewer: Identity = { ...owner, roleId: "viewer" };
  assert.equal((await answerAssistantRead({ ...request, tool: "start_world", kind: "spawnpoint.assistant-tool" }, catalogue, async () => owner)).statusCode, 404, "a write is no read");
  assert.equal((await answerAssistantRead({ ...request, kind: "spawnpoint.assistant-tool" }, catalogue, async () => viewer)).statusCode, 403);
  assert.equal((await answerAssistantRead({ ...request, kind: "spawnpoint.assistant-tool" }, catalogue, async () => null)).statusCode, 403);
});

test("the worker's generated tool list is up to date with the catalogue", async () => {
  const committed = await readFile(new URL("../src/control-plane/assistant-tools.generated.json", import.meta.url), "utf8");
  assert.equal(committed, assistantToolsJson(deployedTools().tools), "run `npm run export-mcp-tools` in lambdas/ and commit the result");
});

test("the Converse adapter sends the tools and keeps the model's reasoning as it came, redacted parts included", async () => {
  const { bedrockConverse } = await import("../src/control-plane/aws-bedrock-assistant-model.ts");
  const sent: Record<string, unknown>[] = [];
  const client = { send: async (command: { input: Record<string, unknown> }) => {
    sent.push(command.input);
    return {
      stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 2 },
      output: { message: { role: "assistant", content: [
        { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
        { toolUse: { toolUseId: "t1", name: "get_control_plane", input: {} } },
      ] } },
    };
  } };
  const port = bedrockConverse(client as never);
  const reply = await port.converse({ modelId: "m", system: "s", messages: [{ role: "user", content: [{ text: "hi" }] }], tools, maxTokens: 10 });
  assert.deepEqual(reply.content, [{ reasoning: { redacted: "AQID" } }, use("t1", "get_control_plane")]);
  await port.converse({ modelId: "m", system: "s", messages: [{ role: "assistant", content: reply.content }, { role: "user", content: [{ toolResult: { toolUseId: "t1", ok: false, text: "no" } }] }], tools, maxTokens: 10 });
  const second = sent[1] as { messages: { content: Record<string, unknown>[] }[]; toolConfig: { tools: { toolSpec: { name: string } }[] } };
  assert.deepEqual([...(second.messages[0]!.content[0]!.reasoningContent as { redactedContent: Uint8Array }).redactedContent], [1, 2, 3]);
  assert.deepEqual(second.messages[1]!.content[0], { toolResult: { toolUseId: "t1", content: [{ text: "no" }], status: "error" } });
  assert.deepEqual(second.toolConfig.tools.map((tool) => tool.toolSpec.name), ["get_control_plane", "start_world"]);
});
