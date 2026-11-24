import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { isAssistantModel } from "../../../contract/assistant.ts";
import { type AssistantJob, assistantConfigFromEnv, runAssistantJob } from "../control-plane/assistant.ts";
import { type AgentTool, runTurn } from "../control-plane/assistant-conversation.ts";
import { tableAssistantAnswers, tableAssistantBudget } from "../control-plane/assistant-store.ts";
import tools from "../control-plane/assistant-tools.generated.json" with { type: "json" };
import { bedrockAssistantModel, bedrockConverse } from "../control-plane/aws-bedrock-assistant-model.ts";
import { lambdaAssistantReads } from "../control-plane/aws-lambda-assistant-reads.ts";
import { tableConversationStore } from "../control-plane/conversation-store.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

// The assistant's worker (ADR-0094, ADR-0096): the API hands it one job at a
// time, asynchronously. A log question carries its redacted log; a
// conversation's turn is read from the table, and its reads go back to the
// API, which runs them as the owner. The worker never runs a write.

type ConversationJob = Readonly<{ kind: "conversation"; identityId: string; conversationId: string }>;

function isConversationJob(event: unknown): event is ConversationJob {
  const job = event as Partial<ConversationJob> | null;
  return job?.kind === "conversation" && typeof job.identityId === "string" && typeof job.conversationId === "string";
}

function isLogJob(event: unknown): event is AssistantJob {
  const job = event as Partial<AssistantJob> | null;
  return typeof job?.worldId === "string" && typeof job.answerId === "string" && isAssistantModel(job.model)
    && typeof job.gameName === "string" && Array.isArray(job.lines) && job.lines.every((line) => typeof line === "string")
    && (job.question === null || typeof job.question === "string");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

const table = dynamoTable(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const bedrock = new BedrockRuntimeClient({});
const lambda = new LambdaClient({});

async function runConversation(job: ConversationJob, tableName: string): Promise<string> {
  const config = assistantConfigFromEnv(process.env);
  const store = tableConversationStore(table, tableName);
  const budget = tableAssistantBudget(table, tableName);
  const conversation = await store.read(job.identityId, job.conversationId);
  if (conversation?.status !== "working") return "skipped";
  let next;
  if (config.enabled) {
    try {
      next = await runTurn(conversation, {
        model: bedrockConverse(bedrock),
        read: lambdaAssistantReads(lambda, () => requiredEnv("ACCESS_API_FUNCTION_NAME")),
        tools: tools as readonly AgentTool[],
        config,
        monthlySpend: budget.monthlySpend,
        addSpend: budget.addSpend,
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "assistant_turn_failed", conversationId: job.conversationId, error: error instanceof Error ? error.message : String(error) }));
      next = { ...conversation, status: "failed" as const, note: "The model could not answer. Try again, or try the other model.", updatedAt: new Date().toISOString() };
    }
  } else {
    next = { ...conversation, status: "failed" as const, note: "The assistant is switched off.", updatedAt: new Date().toISOString() };
  }
  // Written over the version the turn began from: an owner's change meanwhile wins.
  return await store.replace({ ...next, version: conversation.version + 1 }) ? next.status : "conflict";
}

export async function handler(event: unknown): Promise<Readonly<{ status: string }>> {
  const tableName = requiredEnv("ACCESS_TABLE_NAME");
  if (isConversationJob(event)) return { status: await runConversation(event, tableName) };
  if (!isLogJob(event)) throw new Error("the assistant worker was handed something that is not a job");
  const config = assistantConfigFromEnv(process.env);
  const answers = tableAssistantAnswers(table, tableName);
  // Switched off after the API accepted the job: the answer fails, nothing is spent.
  if (!config.enabled) {
    await answers.settle(event.worldId, event.answerId, { status: "failed" });
    return { status: "failed" };
  }
  const model = bedrockAssistantModel(bedrock);
  const outcome = await runAssistantJob(event, { model, answers, budget: tableAssistantBudget(table, tableName), config, now: () => new Date() });
  return { status: outcome.status };
}
