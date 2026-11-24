import { permissionRoute, type Route } from "./routing.ts";
import { deployedAssistant } from "./assistant-wiring.ts";
import { parameter } from "./http.ts";

// The owner's log assistant (ADR-0094). assistant.use is reserved to the Owner role.
export const assistantRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/assistant": permissionRoute("assistant.use", (identity, event) =>
    deployedAssistant.ask(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/assistant/{answerId}": permissionRoute("assistant.use", (_identity, event) =>
    deployedAssistant.answer(parameter(event, "gameId"), parameter(event, "worldId"), parameter(event, "answerId"))),
};
