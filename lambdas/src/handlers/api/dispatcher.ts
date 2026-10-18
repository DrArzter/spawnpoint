import { browserSessionCookieName, refreshCookieName, trustedCookieRequest } from "../../access/login-session.ts";
import { type Event, type Response, type Caller, response, requestCookie } from "./http.ts";
import { type Route } from "./routing.ts";
import { type Identity } from "../../access/domain.ts";
import { requirePermission } from "./permissions.ts";

type Authority = Readonly<{
  caller: (event: Event) => Promise<Caller | null>;
  resolveIdentity: (account: Caller) => Promise<Identity | null>;
  panelOrigins: readonly string[];
}>;

// Every HTTP feature shares this boundary; feature handlers only enforce
// payload-dependent rules. Injectable identity resolution keeps the security
// contract testable without AWS or login-provider configuration.
export function createDispatcher(routes: Readonly<Record<string, Route>>, authority: Authority) {
  return async function handler(event: Event): Promise<Response> {
    const routeKey = event.routeKey ?? `${event.requestContext?.http?.method ?? ""} ${event.rawPath ?? ""}`;
    const route = routes[routeKey];
    // Default deny: an unrouted request never reaches a handler, and neither does
    // a route somebody deployed without declaring its authority here.
    if (route === undefined) return response(404, { error: "not_found" });

    // Cookies are sent automatically, including with SameSite=None on the
    // legacy CloudFront domain. A credential-bearing write must originate from
    // one of the two configured panel origins, even when CORS would hide its
    // response from another site.
    const hasCookie = requestCookie(event, browserSessionCookieName) !== null || requestCookie(event, refreshCookieName) !== null;
    const origin = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "origin")?.[1];
    if (!trustedCookieRequest(routeKey.split(" ", 1)[0]!, hasCookie, origin, authority.panelOrigins)) {
      return response(403, { error: "untrusted_origin" });
    }

    const call = (subject: unknown) =>
      (route.handle as (subject: unknown, event: Event) => Promise<Response> | Response)(subject, event);
    if (route.access.kind === "public") return call(undefined);

    const account = await authority.caller(event);
    if (account === null) return response(401, { error: "invalid_or_expired_session" });
    if (route.access.kind === "session") return call(account);

    const identity = await authority.resolveIdentity(account);
    if (identity === null) return response(403, { error: "access_not_granted" });
    if (route.access.kind === "identity") return call(identity);

    const forbidden = requirePermission(identity, route.access.permission);
    return forbidden ?? call(identity);
  };
}
