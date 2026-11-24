import { type Identity } from "../../access/domain.ts";
import { isAssistantModel, MAX_ASSISTANT_MESSAGE_LENGTH, type AssistantModel } from "../../../../contract/assistant.ts";
import { ASSISTANT_DAILY_LIMIT, type AssistantBudget, type AssistantConfig, utcDay, utcMonth } from "../../control-plane/assistant.ts";
import {
  type AgentTool, clipResult, type Conversation, CONVERSATION_BYTE_LIMIT, conversationView, type ConversationStore, resumeMessage, storedBytes,
  type StoredProposal, titleFrom, type TurnStarter, withOwnerMessage,
} from "../../control-plane/assistant-conversation.ts";
import { type JsonObject, type Response, response, parseJsonObject, errorResponse } from "./http.ts";

// --- Conversations with the owner's assistant (ADR-0096) -----------------------
// The API keeps the conversation, checks the limits and hands each turn to the
// worker. A proposal runs only here, when the owner applies it, through its
// own route as the owner; the worker never runs a write.

export type ConversationDependencies = Readonly<{
  config: Pick<AssistantConfig, "enabled" | "monthlyCapUsd">;
  store: ConversationStore;
  budget: AssistantBudget;
  startTurn: TurnStarter;
  /** Runs a proposal's tool as the owner, through its route, recorded as the assistant's. */
  runWrite: (identity: Identity, tool: string, args: Readonly<Record<string, unknown>>) => Promise<Response | null>;
  tools: () => readonly Pick<AgentTool, "name" | "title">[];
  newId: () => string;
  now: () => Date;
}>;

export type ConversationsFeature = Readonly<{
  list: (identity: Identity) => Promise<Response>;
  create: (identity: Identity, body: string | undefined) => Promise<Response>;
  read: (identity: Identity, conversationId: string) => Promise<Response>;
  send: (identity: Identity, conversationId: string, body: string | undefined) => Promise<Response>;
  apply: (identity: Identity, conversationId: string, proposalId: string) => Promise<Response>;
  reject: (identity: Identity, conversationId: string, proposalId: string) => Promise<Response>;
}>;

type Asked = Readonly<{ message: string; model: AssistantModel | null }>;

function parseMessage(parsed: JsonObject): Asked | null {
  const { message, model } = parsed;
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text === "" || text.length > MAX_ASSISTANT_MESSAGE_LENGTH || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return null;
  if (model !== undefined && !isAssistantModel(model)) return null;
  return { message: text, model: model ?? null };
}

export function conversationsFeature(dependencies: ConversationDependencies): ConversationsFeature {
  const { config, store, budget, startTurn, runWrite, tools, newId, now } = dependencies;
  const view = (conversation: Conversation, status = 200) => response(status, { conversation: conversationView(conversation, tools()) });

  /** The limits a new turn must pass: the month's spend first, so a refusal uses up none of the day's questions. */
  async function limitRefusal(identity: Identity, at: Date): Promise<Response | null> {
    if (await budget.monthlySpend(utcMonth(at)) >= config.monthlyCapUsd * 1_000_000) return errorResponse(429, "assistant_monthly_limit");
    if (!await budget.claimDailyUse(identity.id, utcDay(at), ASSISTANT_DAILY_LIMIT)) return errorResponse(429, "assistant_daily_limit");
    return null;
  }

  /** Writes the next version and hands the turn to the worker; a failed hand-over leaves the conversation failed. */
  async function begin(next: Conversation, created: boolean): Promise<Response> {
    if (created) await store.create(next);
    else if (!await store.replace(next)) return errorResponse(409, "conversation_changed");
    try {
      await startTurn(next.identityId, next.id);
    } catch (error) {
      await store.replace({ ...next, status: "failed", note: "The assistant could not be started.", version: next.version + 1 });
      throw error;
    }
    return view(next, 202);
  }

  async function applied(identity: Identity, proposal: StoredProposal, at: string): Promise<StoredProposal> {
    const answer = await runWrite(identity, proposal.tool, proposal.arguments);
    if (answer === null) return { ...proposal, status: "failed", decidedAt: at, result: "The arguments do not fit the tool." };
    const ok = answer.statusCode >= 200 && answer.statusCode < 300;
    return { ...proposal, status: ok ? "applied" : "failed", decidedAt: at, result: clipResult(answer.body) };
  }

  async function decide(identity: Identity, conversationId: string, proposalId: string, decision: "apply" | "reject"): Promise<Response> {
    if (!config.enabled) return errorResponse(409, "assistant_disabled");
    const conversation = await store.read(identity.id, conversationId);
    if (conversation === null) return errorResponse(404, "unknown_conversation");
    const proposal = conversation.proposals.find((candidate) => candidate.id === proposalId);
    if (proposal === undefined) return errorResponse(404, "unknown_proposal");
    if (proposal.status !== "pending" || conversation.status !== "waiting") return errorResponse(409, "proposal_decided");

    const at = now().toISOString();
    const decided: StoredProposal = decision === "apply"
      ? await applied(identity, proposal, at)
      : { ...proposal, status: "rejected", decidedAt: at, result: null };
    const proposals = conversation.proposals.map((candidate) => (candidate.id === proposalId ? decided : candidate));
    const updated: Conversation = { ...conversation, proposals, updatedAt: at, version: conversation.version + 1 };
    const resumed = resumeMessage(updated);
    if (resumed === null) return await store.replace(updated) ? view(updated) : errorResponse(409, "conversation_changed");
    // Every proposal of the turn is decided: the model sees what came of them.
    return begin({ ...updated, messages: [...updated.messages, resumed], held: [], status: "working" }, false);
  }

  return {
    async list(identity) {
      return response(200, { conversations: await store.list(identity.id) });
    },
    async create(identity, body) {
      const parsed = parseJsonObject({ body });
      if (!config.enabled) return errorResponse(409, "assistant_disabled");
      const asked = parseMessage(parsed);
      if (asked === null || asked.model === null) return errorResponse(400, "invalid_assistant_request");
      const at = now();
      const refused = await limitRefusal(identity, at);
      if (refused) return refused;
      const empty: Conversation = {
        id: newId(), identityId: identity.id, title: titleFrom(asked.message), model: asked.model, status: "idle",
        messages: [], proposals: [], held: [], note: null, createdAt: at.toISOString(), updatedAt: at.toISOString(), version: 1,
      };
      return begin(withOwnerMessage(empty, asked.message, asked.model, at.toISOString()), true);
    },
    async read(identity, conversationId) {
      const conversation = await store.read(identity.id, conversationId);
      return conversation === null ? errorResponse(404, "unknown_conversation") : view(conversation);
    },
    async send(identity, conversationId, body) {
      const parsed = parseJsonObject({ body });
      if (!config.enabled) return errorResponse(409, "assistant_disabled");
      const asked = parseMessage(parsed);
      if (asked === null) return errorResponse(400, "invalid_assistant_request");
      const conversation = await store.read(identity.id, conversationId);
      if (conversation === null) return errorResponse(404, "unknown_conversation");
      // A turn in progress, or proposals waiting, come first.
      if (conversation.status === "working" || conversation.status === "waiting") return errorResponse(409, "conversation_busy");
      if (storedBytes(conversation) > CONVERSATION_BYTE_LIMIT) return errorResponse(409, "conversation_full");
      const at = now();
      const refused = await limitRefusal(identity, at);
      if (refused) return refused;
      const next = withOwnerMessage(conversation, asked.message, asked.model ?? conversation.model, at.toISOString());
      return begin({ ...next, version: conversation.version + 1 }, false);
    },
    apply: (identity, conversationId, proposalId) => decide(identity, conversationId, proposalId, "apply"),
    reject: (identity, conversationId, proposalId) => decide(identity, conversationId, proposalId, "reject"),
  };
}
