import { browserSessionCookieName, refreshCookieName, trustedCookieRequest } from "../../access/login-session.ts";
import { type Event, type Response, type Caller, InvalidBodyError, response, requestCookie, errorResponse } from "./http.ts";
import { type Route } from "./routing.ts";
import { type Identity } from "../../access/domain.ts";
import { requirePermission } from "./permissions.ts";

type Authority = Readonly<{
  caller: (event: Event) => Promise<Caller | null>;
  resolveIdentity: (account: Caller) => Promise<Identity | null>;
  panelOrigins: readonly string[];
}>;

/**
 * The one gate between a resolved identity and a route: what its declared
 * authority asks of the identity. The dispatcher and a tool call (ADR-0095)
 * both pass it; a public or session route is no tool, so a tool call to one is
 * refused.
 */
export function identityRefusal(route: Route, identity: Identity): Response | null {
  if (route.access.kind === "identity") return null;
  if (route.access.kind !== "permission") return errorResponse(403, "forbidden");
  return requirePermission(identity, route.access.permission);
}

// Every HTTP feature shares this boundary; feature handlers only enforce
// payload-dependent rules. Injectable identity resolution keeps the security
// contract testable without AWS or login-provider configuration.
export function createDispatcher(routes: Readonly<Record<string, Route>>, authority: Authority) {
  return async function handler(event: Event): Promise<Response> {
    const routeKey = event.routeKey ?? `${event.requestContext?.http?.method ?? ""} ${event.rawPath ?? ""}`;
    const route = routes[routeKey];
    // Default deny: an unrouted request never reaches a handler, and neither does
    // a route somebody deployed without declaring its authority here.
    if (route === undefined) return errorResponse(404, "not_found");

    // Cookies are sent automatically, including with SameSite=None on the
    // legacy CloudFront domain. A credential-bearing write must originate from
    // one of the two configured panel origins, even when CORS would hide its
    // response from another site.
    const hasCookie = requestCookie(event, browserSessionCookieName) !== null || requestCookie(event, refreshCookieName) !== null;
    const origin = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "origin")?.[1];
    if (!trustedCookieRequest(routeKey.split(" ", 1)[0]!, hasCookie, origin, authority.panelOrigins)) {
      return errorResponse(403, "untrusted_origin");
    }

    // A handler that reads its body throws InvalidBodyError for a body that is
    // not one JSON object. That is the caller's mistake, so it answers 400.
    const call = async (subject: unknown): Promise<Response> => {
      try {
        return await (route.handle as (subject: unknown, event: Event) => Promise<Response> | Response)(subject, event);
      } catch (error) {
        if (error instanceof InvalidBodyError) return errorResponse(400, "invalid_json");
        throw error;
      }
    };
    if (route.access.kind === "public") return call(undefined);

    const account = await authority.caller(event);
    if (account === null) return errorResponse(401, "invalid_or_expired_session");
    if (route.access.kind === "session") return call(account);

    const identity = await authority.resolveIdentity(account);
    if (identity === null) return errorResponse(403, "access_not_granted");
    return identityRefusal(route, identity) ?? call(identity);
  };
}
