import { randomUUID } from "node:crypto";

import { assistantConfigFromEnv } from "../../control-plane/assistant.ts";
import { tableAssistantAnswers, tableAssistantBudget } from "../../control-plane/assistant-store.ts";
import { lambdaAssistantWorker } from "../../control-plane/aws-lambda-assistant-worker.ts";
import { gameCatalog } from "../../control-plane/catalog.ts";
import { accessTable, tableName } from "./access-store.ts";
import { assistantFeature } from "./assistant.ts";
import { lambda } from "./aws-clients.ts";
import { deployedWorldLog } from "./world-log-wiring.ts";

/** The assistant's settings, read once per container. */
export const assistantConfig = assistantConfigFromEnv(process.env);

// The owner's log assistant as deployed: its ports bound to the AWS adapters.
export const deployedAssistant = assistantFeature({
  config: assistantConfig,
  logRead: deployedWorldLog.readLog,
  gameName: (gameId) => gameCatalog.find((game) => game.id === gameId)?.displayName ?? null,
  answers: tableAssistantAnswers(accessTable, tableName),
  budget: tableAssistantBudget(accessTable, tableName),
  worker: lambdaAssistantWorker(lambda, () => {
    const name = process.env.ASSISTANT_FUNCTION_NAME;
    if (!name) throw new Error("missing environment variable: ASSISTANT_FUNCTION_NAME");
    return name;
  }),
  newId: randomUUID,
  now: () => new Date(),
});
