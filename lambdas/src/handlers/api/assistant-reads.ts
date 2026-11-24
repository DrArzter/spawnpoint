import { ASSISTANT_TOOL_REQUEST_KIND, type AssistantToolRequest } from "../../../../contract/assistant.ts";
import { can, type Identity } from "../../access/domain.ts";
import { ASSISTANT_AGENT, type AssistantCatalogue } from "./assistant-wiring.ts";
import { type Response, errorResponse } from "./http.ts";
import { runTool } from "./tool-catalogue.ts";

/*
 * A read the assistant's worker asks the API to run as the owner (ADR-0096).
 * It reaches the API by a direct Lambda invocation, which only the worker's
 * role may make; API Gateway always wraps its events in a request context, so
 * no HTTP request takes this shape. Only a read tool runs, only for an
 * identity that still holds assistant.use, and through the route's own gate.
 */
export function isAssistantToolRequest(event: unknown): event is AssistantToolRequest {
  if (typeof event !== "object" || event === null) return false;
  const request = event as Partial<AssistantToolRequest> & { requestContext?: unknown };
  return request.kind === ASSISTANT_TOOL_REQUEST_KIND && request.requestContext === undefined &&
    typeof request.identityId === "string" && /^[0-9a-f-]{36}$/.test(request.identityId) &&
    typeof request.tool === "string" && typeof request.arguments === "object" && request.arguments !== null && !Array.isArray(request.arguments);
}

export async function answerAssistantRead(
  request: AssistantToolRequest,
  catalogue: AssistantCatalogue,
  identityById: (identityId: string) => Promise<Identity | null>,
): Promise<Response> {
  const identity = await identityById(request.identityId);
  if (identity === null) return errorResponse(403, "access_not_granted");
  if (!can(identity, "assistant.use")) return errorResponse(403, "forbidden");
  const tool = catalogue.tools.find((candidate) => candidate.facts.name === request.tool && candidate.facts.effect === "read");
  if (tool === undefined) return errorResponse(404, "not_found");
  return await runTool(catalogue.routes, tool, identity, request.arguments, ASSISTANT_AGENT) ?? errorResponse(400, "invalid_json");
}
