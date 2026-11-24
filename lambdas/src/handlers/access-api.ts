import { type AssistantToolRequest } from "../../../contract/assistant.ts";
import { type ChatRequest } from "../../../contract/chat.ts";
import { answerAssistantRead, isAssistantToolRequest } from "./api/assistant-reads.ts";
import { chatCaller, chatEvent, chatRoutes, isChatRequest } from "./api/chat.ts";
import { createDispatcher } from "./api/dispatcher.ts";
import { type Event, type Response } from "./api/http.ts";
import { caller } from "./api/login-sessions.ts";
import { identityById, resolveIdentity } from "./api/identity-store.ts";
import { panelUrl, legacyPanelUrl } from "./api/origins.ts";
import { deployedTools, routes } from "./api/route-table.ts";

// The deployed Lambda entry stays stable. Functional modules own their routes;
// this composition root wires the one HTTP authentication/authorization gate.
export { routes, deployedCapabilities } from "./api/route-table.ts";

const http = createDispatcher(routes, {
  caller,
  resolveIdentity,
  panelOrigins: [panelUrl, legacyPanelUrl].filter(Boolean),
});

const chat = chatRoutes(routes);

// A chat surface runs the same routes through the same gate (ADR-0087); only
// the way the caller is known differs. So does the assistant's worker, for a
// read it runs as the owner (ADR-0096).
export async function handler(event: Event | ChatRequest | AssistantToolRequest): Promise<Response> {
  if (isAssistantToolRequest(event)) return answerAssistantRead(event, deployedTools(), identityById);
  if (!isChatRequest(event)) return http(event as Event);
  return createDispatcher(chat, { caller: async () => chatCaller(event), resolveIdentity, panelOrigins: [] })(chatEvent(event));
}
