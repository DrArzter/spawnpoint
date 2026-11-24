import { permissionRoute, type Route } from "./routing.ts";
import { type AssistantCatalogue, deployedAssistant, deployedConversations } from "./assistant-wiring.ts";
import { parameter } from "./http.ts";

// The owner's assistant (ADR-0094, ADR-0096). assistant.use is reserved to the
// Owner role. The conversations read the route table's tools at a request.
export function assistantRoutes(catalogue: () => AssistantCatalogue): Readonly<Record<string, Route>> {
  const conversations = () => deployedConversations(catalogue);
  return {
    "POST /games/{gameId}/worlds/{worldId}/assistant": permissionRoute("assistant.use", (identity, event) =>
      deployedAssistant.ask(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
    "GET /games/{gameId}/worlds/{worldId}/assistant/{answerId}": permissionRoute("assistant.use", (_identity, event) =>
      deployedAssistant.answer(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "answerId"))),
    "GET /assistant/conversations": permissionRoute("assistant.use", (identity) => conversations().list(identity)),
    "POST /assistant/conversations": permissionRoute("assistant.use", (identity, event) => conversations().create(identity, event.body)),
    "GET /assistant/conversations/{conversationId}": permissionRoute("assistant.use", (identity, event) =>
      conversations().read(identity, parameter(event, "conversationId"))),
    "POST /assistant/conversations/{conversationId}/messages": permissionRoute("assistant.use", (identity, event) =>
      conversations().send(identity, parameter(event, "conversationId"), event.body)),
    "POST /assistant/conversations/{conversationId}/proposals/{proposalId}/apply": permissionRoute("assistant.use", (identity, event) =>
      conversations().apply(identity, parameter(event, "conversationId"), parameter(event, "proposalId"))),
    "POST /assistant/conversations/{conversationId}/proposals/{proposalId}/reject": permissionRoute("assistant.use", (identity, event) =>
      conversations().reject(identity, parameter(event, "conversationId"), parameter(event, "proposalId"))),
  };
}
