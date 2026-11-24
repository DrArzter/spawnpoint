import { randomUUID } from "node:crypto";

import { assistantConfigFromEnv } from "../../control-plane/assistant.ts";
import { tableAssistantAnswers, tableAssistantBudget } from "../../control-plane/assistant-store.ts";
import { lambdaAssistantWorker, lambdaTurnStarter } from "../../control-plane/aws-lambda-assistant-worker.ts";
import { tableConversationStore } from "../../control-plane/conversation-store.ts";
import { conversationsFeature, type ConversationsFeature } from "./assistant-conversations.ts";
import { type Route } from "./routing.ts";
import { type CatalogueTool, runTool } from "./tool-catalogue.ts";
import { gameCatalog } from "../../control-plane/catalog.ts";
import { accessTable, tableName } from "./access-store.ts";
import { assistantFeature } from "./assistant.ts";
import { lambda } from "./aws-clients.ts";
import { deployedWorldLog } from "./world-log-wiring.ts";

function workerName(): string {
  const name = process.env.ASSISTANT_FUNCTION_NAME;
  if (!name) throw new Error("missing environment variable: ASSISTANT_FUNCTION_NAME");
  return name;
}

/** The assistant's settings, read once per container. */
export const assistantConfig = assistantConfigFromEnv(process.env);

// The owner's log assistant as deployed: its ports bound to the AWS adapters.
export const deployedAssistant = assistantFeature({
  config: assistantConfig,
  logRead: deployedWorldLog.readLog,
  gameName: (gameId) => gameCatalog.find((game) => game.id === gameId)?.displayName ?? null,
  answers: tableAssistantAnswers(accessTable, tableName),
  budget: tableAssistantBudget(accessTable, tableName),
  worker: lambdaAssistantWorker(lambda, workerName),
  newId: randomUUID,
  now: () => new Date(),
});

/** The route table and its tools, handed in by the composition root (ADR-0095). */
export type AssistantCatalogue = Readonly<{ routes: Readonly<Record<string, Route>>; tools: readonly CatalogueTool[] }>;

/** What the assistant's changes are recorded as, wherever a route records an agent. */
export const ASSISTANT_AGENT = { clientId: "assistant", name: "Assistant" } as const;

let conversations: ConversationsFeature | null = null;

/** The conversations as deployed (ADR-0096), built at the first request from the route table's tools. */
export function deployedConversations(catalogue: () => AssistantCatalogue): ConversationsFeature {
  conversations ??= conversationsFeature({
    config: assistantConfig,
    store: tableConversationStore(accessTable, tableName),
    budget: tableAssistantBudget(accessTable, tableName),
    startTurn: lambdaTurnStarter(lambda, workerName),
    runWrite: async (identity, name, args) => {
      const { routes, tools } = catalogue();
      const tool = tools.find((candidate) => candidate.facts.name === name && candidate.facts.effect === "write");
      return tool === undefined ? null : runTool(routes, tool, identity, args, ASSISTANT_AGENT);
    },
    tools: () => catalogue().tools.map((tool) => ({ name: tool.facts.name, title: tool.facts.title })),
    newId: randomUUID,
    now: () => new Date(),
  });
  return conversations;
}
