import { CHAT_REQUEST_KIND, CHAT_ROUTES, type ChatRequest } from "../../../../contract/chat.ts";
import { type Caller, type Event } from "./http.ts";
import { type Route } from "./routing.ts";

/*
 * A chat request reaches the API by a direct Lambda invocation, which only an
 * IAM principal with lambda:InvokeFunction can make. API Gateway always wraps
 * its events in a request context, so no HTTP request takes this shape.
 */
export function isChatRequest(event: unknown): event is ChatRequest {
  if (typeof event !== "object" || event === null) return false;
  const request = event as Partial<ChatRequest> & { requestContext?: unknown };
  return request.kind === CHAT_REQUEST_KIND && request.requestContext === undefined &&
    request.account?.provider === "telegram" && typeof request.account.subject === "string" && /^\d{1,20}$/.test(request.account.subject) &&
    (CHAT_ROUTES as readonly unknown[]).includes(request.routeKey) &&
    typeof request.pathParameters === "object" && request.pathParameters !== null &&
    (request.body === undefined || typeof request.body === "string");
}

/** Only the routes a chat may run. Each keeps the authority the route table gives it. */
export function chatRoutes(routes: Readonly<Record<string, Route>>): Readonly<Record<string, Route>> {
  return Object.fromEntries(CHAT_ROUTES.map((key) => {
    const route = routes[key];
    if (route === undefined) throw new Error(`chat route ${key} is not in the route table`);
    return [key, route];
  }));
}

export function chatEvent(request: ChatRequest): Event {
  return { routeKey: request.routeKey, pathParameters: { ...request.pathParameters }, headers: {}, ...(request.body === undefined ? {} : { body: request.body }) };
}

/** The chat verified only the account; a chat route needs no profile detail. */
export function chatCaller(request: ChatRequest): Caller {
  return { provider: request.account.provider, subject: request.account.subject, displayName: "", username: null, photoUrl: null, email: null };
}
