import type { AssistantConversation, AssistantModel, ConversationSummary } from "../contract";
import { request } from "./request";
import { t } from "../../i18n";

const REFUSALS = { forbidden: t("assistant.onlyOwnerCanUse") } as const;
const conversationPath = (conversationId: string) => `/assistant/conversations/${encodeURIComponent(conversationId)}`;
const hasConversation = (answer: { conversation?: { id?: unknown } }) => typeof answer.conversation?.id === "string";

// The owner's conversations with the assistant (ADR-0096).
export const assistantApi = {
  async listConversations(): Promise<readonly ConversationSummary[]> {
    const body = await request<{ conversations: readonly ConversationSummary[] }>("/assistant/conversations", {
      failure: t("assistant.conversationsCouldNotRead"), refusals: REFUSALS, valid: (answer) => Array.isArray(answer.conversations),
    });
    return body.conversations;
  },

  async startConversation(model: AssistantModel, message: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>("/assistant/conversations", {
      method: "POST", body: { model, message }, failure: t("assistant.messageCouldNotSent"), refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async loadConversation(conversationId: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(conversationPath(conversationId), {
      failure: t("assistant.conversationCouldNotRead"), refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async sendMessage(conversationId: string, model: AssistantModel, message: string): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(`${conversationPath(conversationId)}/messages`, {
      method: "POST", body: { model, message }, failure: t("assistant.messageCouldNotSent"), refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },

  async decideProposal(conversationId: string, proposalId: string, decision: "apply" | "reject"): Promise<AssistantConversation> {
    const body = await request<{ conversation: AssistantConversation }>(`${conversationPath(conversationId)}/proposals/${encodeURIComponent(proposalId)}/${decision}`, {
      method: "POST", body: {}, failure: decision === "apply" ? t("assistant.changeCouldNotApplied") : t("assistant.proposalCouldNotRejected"),
      refusals: REFUSALS, valid: hasConversation,
    });
    return body.conversation;
  },
};
