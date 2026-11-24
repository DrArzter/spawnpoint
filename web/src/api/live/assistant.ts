import type { AssistantConversation, AssistantModel, ConversationSummary } from "../contract";
import { request } from "./request";

const REFUSALS = { forbidden: "Only an Owner can use the assistant." } as const;
const conversationPath = (conversationId: string) => `/assistant/conversations/${encodeURIComponent(conversationId)}`;
const hasConversation = (answer: { conversation?: { id?: unknown } }) => typeof answer.conversation?.id === "string";

// The owner's conversations with the assistant (ADR-0096).
export const assistantApi = {
  async listConversations(): Promise<readonly ConversationSummary[]> {
    const body = await request<{ conversations: readonly ConversationSummary[] }>("/assistant/conversations", {
      failure: "The conversations could not be read.", refusals: REFUSALS, valid: (answer) => Array.isArray(answer.conversations),
    });
    return body.conversations;
  },

  async startConversation(model: AssistantModel, message: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>("/assistant/conversations", {
      method: "POST", body: { model, message }, failure: "The message could not be sent.", refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async loadConversation(conversationId: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(conversationPath(conversationId), {
      failure: "The conversation could not be read.", refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async sendMessage(conversationId: string, model: AssistantModel, message: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(`${conversationPath(conversationId)}/messages`, {
      method: "POST", body: { model, message }, failure: "The message could not be sent.", refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async decideProposal(conversationId: string, proposalId: string, decision: "apply" | "reject"): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(`${conversationPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/${decision}`, {
      method: "POST", body: {}, failure: decision === "apply" ? "The change could not be applied." : "The proposal could not be rejected.",
      refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },
};
