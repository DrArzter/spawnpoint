import { type Permission, type Identity } from "../../access/domain.ts";
import { type Event, type Response, type Caller } from "./http.ts";

// Feature modules declare authority once per route. The shared dispatcher
// resolves exactly what a route's level requires and refuses before the handler
// runs, so a handler never decides whether it should have been reached — it
// only enforces rules that depend on its own payload, like granting the owner
// role. The keys are the API's own route keys, which is what API Gateway sends;
// access-api-routing.test.ts compares this table with the deployed list so
// neither side can drift silently.
type RouteAccess =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "identity" }>
  | Readonly<{ kind: "permission"; permission: Permission }>;

type Handler<Subject> = (subject: Subject, event: Event) => Promise<Response> | Response;

export type Route = Readonly<{ access: RouteAccess; handle: Handler<never> }>;

// Object spreads silently replace an earlier route. Refuse ambiguous ownership
// at composition time instead of changing a permission or handler by order.
export function composeRoutes(...groups: readonly Readonly<Record<string, Route>>[]): Readonly<Record<string, Route>> {
  const routes: Record<string, Route> = Object.create(null);
  for (const group of groups) {
    for (const [key, route] of Object.entries(group)) {
      if (Object.hasOwn(routes, key)) throw new Error(`duplicate API route: ${key}`);
      routes[key] = route;
    }
  }
  return Object.freeze(routes);
}

// One constructor per access level, so each route reads as a sentence and its
// closure argument is typed by the level rather than asserted at the call.
export const publicRoute = (handle: (event: Event) => Promise<Response> | Response): Route => ({
  access: { kind: "public" },
  handle: ((_subject: never, event: Event) => handle(event)) as Handler<never>,
});

export const sessionRoute = (handle: Handler<Caller>): Route => ({ access: { kind: "session" }, handle: handle as Handler<never> });

export const identityRoute = (handle: Handler<Identity>): Route => ({ access: { kind: "identity" }, handle: handle as Handler<never> });

export const permissionRoute = (permission: Permission, handle: Handler<Identity>): Route => ({
  access: { kind: "permission", permission },
  handle: handle as Handler<never>,
});
