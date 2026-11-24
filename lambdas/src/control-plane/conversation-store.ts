import { isAssistantModel } from "../../../contract/assistant.ts";
import { assistantConversationKey, assistantConversationPartition } from "../access/keys.ts";
import type { AccessTable, StoredItem } from "../access/table.ts";
import {
  CONVERSATION_RECORD_DAYS, type Conversation, type ConversationStatus, type ConversationStore, type ConversationSummary, type HeldResult, type Message,
  type StoredProposal,
} from "./assistant-conversation.ts";

const STATUSES: ReadonlySet<string> = new Set<ConversationStatus>(["working", "waiting", "idle", "failed"]);
/** The conversations an owner's list shows, newest first. */
const LIST_LIMIT = 50;

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function statusOf(value: unknown): ConversationStatus {
  return typeof value === "string" && STATUSES.has(value) ? value as ConversationStatus : "failed";
}

function summaryFromItem(item: StoredItem): ConversationSummary | null {
  if (!isAssistantModel(item.model)) return null;
  return { id: String(item.conversation_id), title: String(item.title ?? ""), model: item.model, status: statusOf(item.status), updatedAt: String(item.updated_at) };
}

type Body = Readonly<{ messages: readonly Message[]; proposals: readonly StoredProposal[]; held: readonly HeldResult[] }>;

function conversationFromItem(item: StoredItem): Conversation | null {
  const summary = summaryFromItem(item);
  if (summary === null || typeof item.body !== "string") return null;
  const body = JSON.parse(item.body) as Partial<Body>;
  return {
    ...summary,
    identityId: String(item.identity_id),
    messages: body.messages ?? [], proposals: body.proposals ?? [], held: body.held ?? [],
    note: typeof item.note === "string" ? item.note : null,
    createdAt: String(item.created_at),
    version: typeof item.version === "number" ? item.version : 1,
  };
}

function itemOf(conversation: Conversation): Record<string, unknown> {
  const body: Body = { messages: conversation.messages, proposals: conversation.proposals, held: conversation.held };
  return {
    ...assistantConversationKey(conversation.identityId, conversation.id),
    conversation_id: conversation.id, identity_id: conversation.identityId, title: conversation.title, model: conversation.model,
    status: conversation.status, created_at: conversation.createdAt, updated_at: conversation.updatedAt, version: conversation.version,
    body: JSON.stringify(body),
    ...(conversation.note === null ? {} : { note: conversation.note }),
    ttl: Math.floor(Date.parse(conversation.updatedAt) / 1000) + CONVERSATION_RECORD_DAYS * 24 * 3600,
  };
}

/** Conversations in the access table, one partition per owner (ADR-0096). */
export function tableConversationStore(table: AccessTable, name: string): ConversationStore {
  return {
    list: async (identityId) => {
      const page = await table.query({
        TableName: name, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": assistantConversationPartition(identityId) },
        ProjectionExpression: "conversation_id, title, #model, #status, updated_at",
        ExpressionAttributeNames: { "#model": "model", "#status": "status" },
      });
      return (page.Items ?? []).map(summaryFromItem).filter((summary): summary is ConversationSummary => summary !== null)
        .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1)).slice(0, LIST_LIMIT);
    },
    read: async (identityId, conversationId) => {
      const { Item: item } = await table.get({ TableName: name, Key: assistantConversationKey(identityId, conversationId), ConsistentRead: true });
      return item === undefined ? null : conversationFromItem(item);
    },
    create: async (conversation) => {
      await table.put({ TableName: name, Item: itemOf(conversation), ConditionExpression: "attribute_not_exists(pk)" });
    },
    replace: async (next) => {
      try {
        await table.put({
          TableName: name, Item: itemOf(next), ConditionExpression: "#version = :previous",
          ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":previous": next.version - 1 },
        });
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
  };
}
