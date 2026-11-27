import { type AssistantToolRequest } from "../../../contract/assistant.ts";
import { type ChatRequest } from "../../../contract/chat.ts";
import { answerAssistantRead, isAssistantToolRequest } from "./api/assistant-reads.ts";
import { chatCaller, chatEvent, chatRoutes, isChatRequest } from "./api/chat.ts";
import { createDispatcher } from "./api/dispatcher.ts";
import { type Event, type Response } from "./api/http.ts";
import { caller } from "./api/login-sessions.ts";
import { identityById, resolveIdentity } from "./api/identity-store.ts";
import { panelUrl, legacyPanelUrl } from "./api/origins.ts";
import { apiDeployment } from "./api/route-table.ts";
import { CAPABILITY_NAMES } from "./api/capabilities.ts";
import { ssm } from "./api/aws-clients.ts";
import { ssmFeatureFlags } from "./api/ssm-feature-flags.ts";

// The deployed Lambda entry stays stable. Functional modules own their routes;
// this composition root wires the one HTTP authentication/authorization gate,
// under the feature flags the owner keeps in SSM (ADR-0107).
const deployment = apiDeployment(ssmFeatureFlags(ssm, CAPABILITY_NAMES));

export const routes = deployment.routes;
export const deployedCapabilities = deployment.capabilities;

const http = createDispatcher(routes, {
  caller,
  resolveIdentity,
  panelOrigins: [panelUrl, legacyPanelUrl].filter(Boolean),
  switchedOff: deployment.switchedOff,
});

const chat = chatRoutes(routes);

// A chat surface runs the same routes through the same gate (ADR-0087); only
// the way the caller is known differs. So does the assistant's worker, for a
// read it runs as the owner (ADR-0096).
export async function handler(event: Event | ChatRequest | AssistantToolRequest): Promise<Response> {
  if (isAssistantToolRequest(event)) return answerAssistantRead(event, deployment.tools(), identityById);
  if (!isChatRequest(event)) return http(event as Event);
  return createDispatcher(chat, { caller: async () => chatCaller(event), resolveIdentity, panelOrigins: [], switchedOff: deployment.switchedOff })(chatEvent(event));
}
