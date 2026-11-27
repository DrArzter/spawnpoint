import { type Identity, type Permission } from "../../access/domain.ts";
import { type Event, type Response, InvalidBodyError, errorResponse } from "./http.ts";
import { featureRefusal, identityRefusal } from "./dispatcher.ts";
import { type ArgumentSchema, isToolFacts, type Route, type ToolFacts } from "./routing.ts";

/*
 * The operation catalogue (ADR-0095). Each feature declares its routes' tools
 * beside the routes; MCP and the assistant read them from the route table, so
 * a feature reaches every agent by declaring itself once. A tool call becomes
 * a request to its own route and passes the same permission check.
 */

const text = (description: string, extra: ArgumentSchema = {}): ArgumentSchema => ({ type: "string", minLength: 1, description, ...extra });

/** Every path parameter a tool route names, described once for every tool. */
export const PATH_ARGUMENTS: Readonly<Record<string, ArgumentSchema>> = {
  gameId: text("Game ID from get_control_plane, for example minecraft"),
  worldId: text("World ID from get_control_plane"),
  presetId: text("Preset ID from get_control_plane"),
  version: text("Release version from get_control_plane, for example 1.2", { pattern: String.raw`^\d+\.\d+$` }),
  sha256: text("The mod's SHA-256 digest from get_release", { pattern: "^[0-9a-f]{64}$" }),
  pack: { type: "string", enum: ["server", "full"], description: "Which pack: the server's files, or the full client pack" },
  operationId: text("The operation's id, from get_control_plane or the call that started it"),
  instanceId: text("Host ID from get_control_plane"),
  commandId: text("The id send_console_command returned"),
  readId: text("The id read_world_log returned"),
  roleId: text("Role ID from list_roles", { pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }),
  identityId: text("Identity ID from list_identities", { pattern: "^[0-9a-f-]{36}$" }),
  platform: text("The waiting account's login provider, from list_access_candidates"),
  platformUserId: text("The waiting account's id at its provider, from list_access_candidates"),
  invitationId: text("Access invitation ID from list_access_invitations"),
};

export type CatalogueTool = Readonly<{
  routeKey: string;
  method: string;
  /** The route's path, its parameters in braces. */
  path: string;
  permission: Permission | null;
  facts: ToolFacts;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

function pathParameters(path: string): readonly string[] {
  return [...path.matchAll(/\{([A-Za-z0-9]+)\}/g)].map((match) => match[1]!);
}

/** The name an agent gives a path parameter. */
function argumentName(facts: ToolFacts, parameter: string): string {
  return facts.pathNames?.[parameter] ?? parameter;
}

function inputSchemaOf(path: string, facts: ToolFacts): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of pathParameters(path)) {
    const schema = PATH_ARGUMENTS[parameter];
    if (schema === undefined) throw new Error(`tool ${facts.name}: path parameter ${parameter} has no description in PATH_ARGUMENTS`);
    const name = argumentName(facts, parameter);
    properties[name] = schema;
    if (name === parameter) required.push(name);
    else properties[parameter] = { ...schema, description: `The old name of ${name}: give ${name} instead` };
  }
  for (const [name, schema] of Object.entries(facts.input ?? {})) {
    if (Object.hasOwn(properties, name)) throw new Error(`tool ${facts.name}: ${name} is both a path parameter and an input`);
    properties[name] = schema;
  }
  return { type: "object", properties, required: [...required, ...(facts.required ?? [])], additionalProperties: false };
}

/** The tools the route table declares, by name. Two tools of one name are refused. */
export function toolCatalogue(routes: Readonly<Record<string, Route>>): readonly CatalogueTool[] {
  const tools: CatalogueTool[] = [];
  const names = new Set<string>();
  for (const [routeKey, route] of Object.entries(routes)) {
    if (!isToolFacts(route.tool)) continue;
    const facts = route.tool;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(facts.name)) throw new Error(`tool name ${facts.name} is not snake_case`);
    if (names.has(facts.name)) throw new Error(`duplicate tool: ${facts.name}`);
    names.add(facts.name);
    const [method = "", path = ""] = routeKey.split(" ");
    tools.push({
      routeKey, method, path, facts,
      permission: route.access.kind === "permission" ? route.access.permission : null,
      inputSchema: inputSchemaOf(path, facts),
    });
  }
  return tools.sort((left, right) => (left.facts.name < right.facts.name ? -1 : 1));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request a tool call makes to its own route, or null for arguments that
 * do not fit: a missing or empty path argument, or one the tool does not take.
 * Each value is checked again by the route's handler, as a browser's would be.
 */
export function toolEvent(tool: CatalogueTool, args: unknown, agent?: Readonly<{ clientId: string; name: string }>): Event | null {
  if (!isPlainObject(args)) return null;
  const known = new Set(Object.keys(isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}));
  if (Object.keys(args).some((name) => !known.has(name))) return null;
  const pathValues: Record<string, string> = {};
  const used = new Set<string>();
  for (const parameter of pathParameters(tool.path)) {
    const name = argumentName(tool.facts, parameter);
    const value = args[name] ?? args[parameter];
    if (typeof value !== "string" || value === "") return null;
    pathValues[parameter] = value;
    used.add(name).add(parameter);
  }
  const rest = Object.fromEntries(Object.entries(args).filter(([name]) => !used.has(name)));
  const event: { -readonly [K in keyof Event]: Event[K] } = { routeKey: tool.routeKey, pathParameters: pathValues, headers: {} };
  if (tool.method === "POST" || tool.method === "PUT") event.body = JSON.stringify(rest);
  else if (Object.keys(rest).length > 0) {
    event.queryStringParameters = Object.fromEntries(Object.entries(rest).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)]));
  }
  if (agent !== undefined) event.agent = agent;
  return event;
}

/**
 * Runs one tool as `identity`, through its route's own permission and
 * handler. Null for arguments that do not fit the tool.
 */
export async function runTool(
  routes: Readonly<Record<string, Route>>,
  tool: CatalogueTool,
  identity: Identity,
  args: unknown,
  agent?: Readonly<{ clientId: string; name: string }>,
  /** The route keys the feature flags switched off (ADR-0107). */
  switchedOff: ReadonlySet<string> = new Set(),
): Promise<Response | null> {
  const route = routes[tool.routeKey];
  if (route === undefined) return errorResponse(404, "not_found");
  const event = toolEvent(tool, args, agent);
  if (event === null) return null;
  const refused = identityRefusal(route, identity) ?? featureRefusal(tool.routeKey, switchedOff);
  if (refused) return refused;
  try {
    return await (route.handle as (subject: Identity, event: Event) => Promise<Response> | Response)(identity, event);
  } catch (error) {
    if (error instanceof InvalidBodyError) return errorResponse(400, "invalid_json");
    throw error;
  }
}

/** What the local stdio adapter needs of each MCP tool: its route, and no permission data. */
export function localToolsJson(tools: readonly CatalogueTool[], builtIn: readonly Readonly<Record<string, unknown>>[]): string {
  const derived = tools.filter((tool) => tool.facts.mcp === true).map((tool) => ({
    name: tool.facts.name,
    title: tool.facts.title,
    description: tool.facts.description,
    readOnly: tool.facts.effect === "read",
    destructive: tool.facts.destructive === true,
    route: tool.routeKey,
    ...(tool.facts.pathNames === undefined ? {} : { pathNames: tool.facts.pathNames }),
    inputSchema: tool.inputSchema,
  }));
  return `${JSON.stringify([...builtIn, ...derived].sort((left, right) => String(left.name) < String(right.name) ? -1 : 1), null, 2)}\n`;
}

/** Every tool as the assistant's model is offered it (ADR-0096): no route, no permission. */
export function assistantToolsJson(tools: readonly CatalogueTool[]): string {
  const offered = tools.map((tool) => ({
    name: tool.facts.name, title: tool.facts.title, description: tool.facts.description,
    effect: tool.facts.effect, destructive: tool.facts.destructive === true, inputSchema: tool.inputSchema,
  }));
  return `${JSON.stringify(offered, null, 2)}\n`;
}
