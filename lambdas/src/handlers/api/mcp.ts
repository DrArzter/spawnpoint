import { type Identity, type Permission, can, permissionsOf, roleOf } from "../../access/domain.ts";
import { type OAuthScope, verifyOAuthAccessToken } from "../../access/oauth.ts";
import { type Response, type JsonObject, InvalidBodyError, parseJsonObject, parseJsonText, response, responseWithHeaders, type Event } from "./http.ts";
import { oauthClient, oauthProtectedResourceMetadata, oauthIssuer, oauthResource } from "./oauth.ts";
import { sessionSigningSecret } from "./aws-secrets.ts";
import { identityById } from "./identity-store.ts";
import { type CatalogueTool, runTool } from "./tool-catalogue.ts";
import { type Route } from "./routing.ts";

type McpRequest = Readonly<{ jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }>;

/** The route table and its tools, handed in by the composition root (ADR-0095). */
export type McpCatalogue = Readonly<{
  routes: Readonly<Record<string, Route>>;
  tools: readonly CatalogueTool[];
  /** The route keys the feature flags switched off (ADR-0107): their tools are neither listed nor run. */
  switchedOff?: () => Promise<ReadonlySet<string>>;
}>;

function mcpJson(id: unknown, result: unknown): Response {
  return response(200, { jsonrpc: "2.0", id, result });
}

function mcpError(id: unknown, code: number, message: string): Response {
  return response(200, { jsonrpc: "2.0", id, error: { code, message } });
}

function mcpResult(data: unknown): Record<string, unknown> {
  return { structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function mcpToolError(message: string): Response {
  return response(200, { ...mcpResult({ error: message }), isError: true });
}

/** The connected identity as an agent sees it: the same permissions the panel shows, the role's and the direct grants. */
export function mcpProfile(identity: Identity): Readonly<{ id: string; name: string; role: string; permissions: readonly Permission[] }> {
  return { id: identity.id, name: identity.displayName, role: roleOf(identity)?.name ?? identity.roleId, permissions: [...permissionsOf(identity)] };
}

/** Who the call came through: the OAuth client the person connected. */
type McpCaller = Readonly<{ identity: Identity; clientId: string }>;

/** One tool as MCP offers it. A read needs the read scope; a write, the operate scope (ADR-0061). */
type McpTool = Readonly<{
  name: string; title: string; description: string; inputSchema: Readonly<Record<string, unknown>>;
  readOnly: boolean; destructive: boolean; scope: OAuthScope; permission: Permission | null;
  call: (caller: McpCaller, args: Record<string, unknown>) => Promise<Response | null>;
}>;

/** The one tool that is no route: the connected identity itself. */
export const PROFILE_TOOL = {
  name: "get_profile", title: "Get Spawnpoint profile", description: "Read the connected Spawnpoint identity and role.",
  readOnly: true, destructive: false, route: "GET /me", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
} as const;

async function agentOf(clientId: string): Promise<Readonly<{ clientId: string; name: string }>> {
  return { clientId, name: (await oauthClient(clientId))?.name ?? clientId };
}

/** The tools MCP offers: the profile, and each catalogue tool a feature offered to MCP. */
export function mcpTools(catalogue: McpCatalogue, switchedOff: ReadonlySet<string> = new Set()): readonly McpTool[] {
  const profile: McpTool = {
    ...PROFILE_TOOL, scope: "spawnpoint.read", permission: null,
    call: async (caller) => {
      const value = mcpProfile(caller.identity);
      return response(200, { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
    },
  };
  return [profile, ...catalogue.tools.filter((tool) => tool.facts.mcp === true && !switchedOff.has(tool.routeKey)).map((tool): McpTool => ({
    name: tool.facts.name, title: tool.facts.title, description: tool.facts.description, inputSchema: tool.inputSchema,
    readOnly: tool.facts.effect === "read", destructive: tool.facts.destructive === true,
    scope: tool.facts.effect === "read" ? "spawnpoint.read" : "spawnpoint.operate",
    permission: tool.permission,
    // The record names the client as well as the person.
    call: async (caller, args) => runTool(catalogue.routes, tool, caller.identity, args, await agentOf(caller.clientId), switchedOff),
  }))];
}

async function callMcpTool(catalogue: McpCatalogue, caller: McpCaller, scopes: readonly OAuthScope[], name: string, args: Record<string, unknown>): Promise<Response> {
  const tool = mcpTools(catalogue, await catalogue.switchedOff?.()).find((candidate) => candidate.name === name);
  if (tool === undefined) return mcpToolError(`Unknown tool: ${name}`);
  if (!scopes.includes(tool.scope)) return response(403, { error: "insufficient_scope" });
  if (tool.permission !== null && !can(caller.identity, tool.permission)) return response(403, { error: "forbidden" });
  const apiResponse = await tool.call(caller, args);
  if (apiResponse === null) return mcpToolError("Invalid tool arguments");
  if (name === PROFILE_TOOL.name) return apiResponse;
  const data = parseJsonText(apiResponse.body || "null");
  return apiResponse.statusCode >= 200 && apiResponse.statusCode < 300
    ? response(200, mcpResult(data))
    : response(200, { ...mcpResult(data), isError: true });
}

function mcpUnauthorized(): Response {
  return responseWithHeaders(401, { error: "invalid_token" }, {
    "www-authenticate": `Bearer resource_metadata="${oauthProtectedResourceMetadata}"`,
  });
}

async function authenticateRemoteMcp(event: Event): Promise<Readonly<{ identity: Identity; clientId: string; scopes: readonly OAuthScope[] }> | null> {
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const bearer = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1];
  const subject = bearer ? verifyOAuthAccessToken(bearer, oauthIssuer, oauthResource, await sessionSigningSecret()) : null;
  if (subject === null) return null;
  const identity = await identityById(subject.identityId);
  return identity === null ? null : { identity, clientId: subject.clientId, scopes: subject.scopes };
}

function initializeMcp(request: McpRequest): Response {
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
  const protocolVersion = ["2025-11-25", "2025-06-18", "2025-03-26"].includes(requestedVersion) ? requestedVersion : "2025-11-25";
  return mcpJson(request.id, {
    protocolVersion, capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "spawnpoint", version: "0.2.0" },
    instructions: "Read current state before changing a world. Operations are asynchronous and remain subject to Spawnpoint permissions.",
  });
}

async function listMcpTools(catalogue: McpCatalogue, id: unknown): Promise<Response> {
  return mcpJson(id, { tools: mcpTools(catalogue, await catalogue.switchedOff?.()).map((tool) => ({
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }], ...(tool.name === "get_profile" ? { "openai/profile": true } : {}) },
  })) });
}

async function callRemoteMcpTool(catalogue: McpCatalogue, request: McpRequest, caller: McpCaller, scopes: readonly OAuthScope[]): Promise<Response> {
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const args = params.arguments !== null && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const name = typeof params.name === "string" ? params.name : "";
  const called = await callMcpTool(catalogue, caller, scopes, name, args);
  const payload = parseJsonText(called.body || "null");
  return called.statusCode === 200 ? mcpJson(request.id, payload) : mcpJson(request.id, { ...mcpResult(payload), isError: true });
}

export async function remoteMcp(event: Event, catalogue: McpCatalogue): Promise<Response> {
  const authenticated = await authenticateRemoteMcp(event);
  if (authenticated === null) return mcpUnauthorized();
  let body: JsonObject;
  try { body = parseJsonObject(event); } catch (error) {
    if (error instanceof InvalidBodyError) return mcpError(null, -32600, "Invalid Request");
    throw error;
  }
  const request = body as McpRequest;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return mcpError(request.id ?? null, -32600, "Invalid Request");
  if (request.method === "notifications/initialized") return response(202, null);
  if (request.method === "initialize") return initializeMcp(request);
  if (request.method === "tools/list") return listMcpTools(catalogue, request.id);
  if (request.method === "tools/call") return callRemoteMcpTool(catalogue, request, authenticated, authenticated.scopes);
  return mcpError(request.id, -32601, "Method not found");
}
