import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { isAssistantModel } from "../../../contract/assistant.ts";
import { type AssistantJob, assistantConfigFromEnv, runAssistantJob } from "../control-plane/assistant.ts";
import { tableAssistantAnswers, tableAssistantBudget } from "../control-plane/assistant-store.ts";
import { bedrockAssistantModel } from "../control-plane/aws-bedrock-assistant-model.ts";
import { dynamoTable } from "../control-plane/dynamo-table.ts";

// The assistant's worker (ADR-0094): the API hands it one job at a time,
// asynchronously. It asks the model and stores the answer; it reads no world.

function isJob(event: unknown): event is AssistantJob {
  const job = event as Partial<AssistantJob> | null;
  return typeof job?.worldId === "string" && typeof job.answerId === "string" && isAssistantModel(job.model)
    && typeof job.gameName === "string" && Array.isArray(job.lines) && job.lines.every((line) => typeof line === "string")
    && (job.question === null || typeof job.question === "string");
}

const table = dynamoTable(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const model = bedrockAssistantModel(new BedrockRuntimeClient({}));

export async function handler(event: unknown): Promise<Readonly<{ status: string }>> {
  if (!isJob(event)) throw new Error("the assistant worker was handed something that is not a job");
  const tableName = process.env.ACCESS_TABLE_NAME;
  if (!tableName) throw new Error("missing environment variable: ACCESS_TABLE_NAME");
  const config = assistantConfigFromEnv(process.env);
  const answers = tableAssistantAnswers(table, tableName);
  // Switched off after the API accepted the job: the answer fails, nothing is spent.
  if (!config.enabled) {
    await answers.settle(event.worldId, event.answerId, { status: "failed" });
    return { status: "failed" };
  }
  const outcome = await runAssistantJob(event, { model, answers, budget: tableAssistantBudget(table, tableName), config, now: () => new Date() });
  return { status: outcome.status };
}
