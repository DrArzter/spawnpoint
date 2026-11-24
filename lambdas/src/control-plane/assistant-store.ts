import { isAssistantModel } from "../../../contract/assistant.ts";
import { assistantAnswerKey, assistantDailyUseKey, assistantMonthlySpendKey } from "../access/keys.ts";
import type { AccessTable, StoredItem } from "../access/table.ts";
import { ASSISTANT_RECORD_DAYS, type AssistantAnswer, type AssistantAnswers, type AssistantBudget, type AssistantStatus } from "./assistant.ts";

const DAY_SECONDS = 24 * 3600;
const STATUSES: ReadonlySet<string> = new Set<AssistantStatus>(["pending", "succeeded", "failed"]);

function isConditionFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function answerFromItem(item: StoredItem): AssistantAnswer | null {
  if (!isAssistantModel(item.model)) return null;
  return {
    id: String(item.answer_id),
    at: String(item.created_at),
    logReadId: String(item.log_read_id),
    model: item.model,
    question: typeof item.question === "string" ? item.question : null,
    status: STATUSES.has(item.status) ? item.status as AssistantStatus : "failed",
    text: typeof item.text === "string" ? item.text : null,
  };
}

/** The assistant's answers in the access table, one partition per world (ADR-0094). */
export function tableAssistantAnswers(table: AccessTable, name: string): AssistantAnswers {
  return {
    create: async ({ answer, gameId, worldId, identityId }) => {
      await table.put({ TableName: name, Item: {
        ...assistantAnswerKey(worldId, answer.id), answer_id: answer.id, created_at: answer.at, game_id: gameId, world_id: worldId,
        identity_id: identityId, log_read_id: answer.logReadId, model: answer.model, status: answer.status,
        ...(answer.question === null ? {} : { question: answer.question }),
        ttl: Math.floor(Date.parse(answer.at) / 1000) + ASSISTANT_RECORD_DAYS * DAY_SECONDS,
      } });
    },
    find: async (gameId, worldId, answerId) => {
      const { Item: item } = await table.get({ TableName: name, Key: assistantAnswerKey(worldId, answerId) });
      return item?.game_id === gameId ? answerFromItem(item) : null;
    },
    settle: async (worldId, answerId, outcome) => {
      const values: Record<string, unknown> = { ":status": outcome.status, ":pending": "pending", ":now": new Date().toISOString() };
      let set = "#status = :status, completed_at = :now";
      if (outcome.status === "succeeded") {
        set += ", #text = :text, input_tokens = :input, output_tokens = :output, cost_micro_usd = :cost";
        Object.assign(values, { ":text": outcome.text, ":input": outcome.usage.inputTokens, ":output": outcome.usage.outputTokens, ":cost": outcome.costMicroUsd });
      }
      try {
        await table.update({
          TableName: name, Key: assistantAnswerKey(worldId, answerId), UpdateExpression: `SET ${set}`,
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status", ...(outcome.status === "succeeded" ? { "#text": "text" } : {}) },
          ExpressionAttributeValues: values,
        });
      } catch (error) {
        // A retried worker settles an answer once; the first outcome stands.
        if (!isConditionFailure(error)) throw error;
      }
    },
  };
}

/** The assistant's daily counts and monthly spend in the access table. */
export function tableAssistantBudget(table: AccessTable, name: string, now: () => Date = () => new Date()): AssistantBudget {
  const expires = (days: number) => Math.floor(now().getTime() / 1000) + days * DAY_SECONDS;
  return {
    claimDailyUse: async (identityId, day, limit) => {
      try {
        await table.update({
          TableName: name, Key: assistantDailyUseKey(identityId, day),
          UpdateExpression: "SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :one",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": expires(2) },
        });
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },
    monthlySpend: async (month) => {
      const { Item: item } = await table.get({ TableName: name, Key: assistantMonthlySpendKey(month), ConsistentRead: true });
      return typeof item?.micro_usd === "number" ? item.micro_usd : 0;
    },
    addSpend: async (month, microUsd) => {
      await table.update({
        TableName: name, Key: assistantMonthlySpendKey(month),
        UpdateExpression: "SET #ttl = if_not_exists(#ttl, :ttl) ADD micro_usd :cost",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":cost": microUsd, ":ttl": expires(400) },
      });
    },
  };
}
