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

/** One argument of a tool, as a JSON schema. */
export type ArgumentSchema = Readonly<Record<string, unknown>>;

/**
 * What a route is to an agent (ADR-0095): a tool, named and described once,
 * which MCP and the assistant both derive from. The path's parameters are
 * arguments of their own; `input` names the rest, which a POST or PUT sends
 * as its body and a GET or DELETE as its query.
 */
export type ToolFacts = Readonly<{
  name: string;
  title: string;
  description: string;
  input?: Readonly<Record<string, ArgumentSchema>>;
  /** The input arguments a call must give. A path parameter is required unless it is renamed. */
  required?: readonly string[];
  /** A read changes nothing anyone would undo; a write is a change, which the assistant only proposes. */
  effect: "read" | "write";
  /** A write that loses something: a world's data, a release, a person's access. */
  destructive?: boolean;
  /** Offered to MCP clients too (ADR-0061). Every tool is the assistant's. */
  mcp?: boolean;
  /** A path parameter an agent names otherwise, its own name still accepted: { instanceId: "hostId" }. */
  pathNames?: Readonly<Record<string, string>>;
}>;

/** A route's tool, or why it is none: every route says which (ADR-0095). */
export type RouteTool = ToolFacts | Readonly<{ excluded: string }>;

export type Route = Readonly<{ access: RouteAccess; handle: Handler<never>; tool?: RouteTool }>;

export function isToolFacts(tool: RouteTool | undefined): tool is ToolFacts {
  return tool !== undefined && "name" in tool;
}

/** Marks every route of a group as no tool, for one reason: signing in, a person's own profile. */
export function withoutTools(reason: string, group: Readonly<Record<string, Route>>): Readonly<Record<string, Route>> {
  return Object.fromEntries(Object.entries(group).map(([key, route]) => [key, { ...route, tool: { excluded: reason } }]));
}

/** One route that is no tool, in a group whose others are. */
export function notATool(reason: string, route: Route): Route {
  return { ...route, tool: { excluded: reason } };
}

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

export const identityRoute = (handle: Handler<Identity>, tool?: ToolFacts): Route => ({
  access: { kind: "identity" },
  handle: handle as Handler<never>,
  ...(tool === undefined ? {} : { tool }),
});

export const permissionRoute = (permission: Permission, handle: Handler<Identity>, tool?: ToolFacts): Route => ({
  access: { kind: "permission", permission },
  handle: handle as Handler<never>,
  ...(tool === undefined ? {} : { tool }),
});
