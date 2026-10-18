import { type Identity, type Permission, isBuiltInRoleId, builtInRoles, hasPermission } from "../../access/domain.ts";
import { type McpToolName, mcpTools } from "../../access/mcp-tools.ts";
import { type OAuthScope, verifyOAuthAccessToken } from "../../access/oauth.ts";
import { type Response, response, responseWithHeaders, type Event } from "./http.ts";
import { type ConsoleAgent, runConsoleCommand, consoleCommandResult } from "./console.ts";
import { oauthClient, oauthProtectedResourceMetadata, oauthIssuer, oauthResource, jsonBody } from "./oauth.ts";
import { controlPlane } from "./control-plane.ts";
import { hostMetrics } from "./metrics.ts";
import { backups, backupDownload } from "./backups.ts";
import { packDownload, releaseManifest, releaseModDownload } from "./releases.ts";
import { controlSession } from "./worlds.ts";
import { sessionSigningSecret } from "./secrets.ts";
import { identityById } from "./identity-store.ts";

type McpRequest = Readonly<{ jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }>;

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

function hasMcpToolPermission(identity: Identity, permission: Permission | null): boolean {
  if (permission === null) return true;
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission);
}

function worldToolArguments(args: Record<string, unknown>): readonly [string, string] | null {
  return typeof args.gameId === "string" && args.gameId.length > 0 && typeof args.worldId === "string" && args.worldId.length > 0
    ? [args.gameId, args.worldId]
    : null;
}

function metricsToolArguments(args: Record<string, unknown>): readonly [string, string] | null {
  const range = args.range ?? "24h";
  return typeof args.instanceId === "string" && typeof range === "string" && ["1h", "6h", "24h", "7d"].includes(range)
    ? [args.instanceId, range]
    : null;
}

// The handlers check each value's format; here a value only has to be text.
function releaseToolArguments(args: Record<string, unknown>): readonly [string, string, string] | null {
  const { gameId, presetId, version } = args;
  return typeof gameId === "string" && typeof presetId === "string" && typeof version === "string" ? [gameId, presetId, version] : null;
}

function profileToolResponse(identity: Identity): Response {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
  const profile = { id: identity.id, name: identity.displayName, role: role?.name ?? identity.roleId, permissions: role?.permissions ?? identity.directGrants };
  return response(200, { structuredContent: profile, content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] });
}

/** Who the call came through: the OAuth client the person connected. */
type McpCaller = Readonly<{ identity: Identity; clientId: string }>;

type McpToolCall = (identity: Identity, args: Record<string, unknown>, caller: McpCaller) => Promise<Response> | Response | null;

async function consoleAgent(clientId: string): Promise<ConsoleAgent> {
  return { clientId, name: (await oauthClient(clientId))?.name ?? clientId };
}

// Each tool runs the handler its web route runs; null means invalid arguments.
const mcpToolCalls: Readonly<Record<McpToolName, McpToolCall>> = {
  get_profile: (identity) => profileToolResponse(identity),
  get_control_plane: (identity) => controlPlane(identity),
  get_host_metrics: (_identity, args) => {
    const metricsArgs = metricsToolArguments(args);
    return metricsArgs === null ? null : hostMetrics(...metricsArgs);
  },
  list_world_backups: (_identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null ? null : backups(...worldArgs);
  },
  get_world_pack: (_identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null ? null : packDownload(...worldArgs);
  },
  get_release: (_identity, args) => {
    const releaseArgs = releaseToolArguments(args);
    return releaseArgs === null ? null : releaseManifest(...releaseArgs);
  },
  get_release_mod_link: (_identity, args) => {
    const releaseArgs = releaseToolArguments(args);
    return releaseArgs === null || typeof args.sha256 !== "string" ? null : releaseModDownload(...releaseArgs, args.sha256);
  },
  get_backup_download_link: (identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null || typeof args.key !== "string" ? null : backupDownload(identity, ...worldArgs, JSON.stringify({ key: args.key }));
  },
  send_console_command: (identity, args, caller) => {
    const worldArgs = worldToolArguments(args);
    if (worldArgs === null || typeof args.command !== "string") return null;
    const body = JSON.stringify({ command: args.command });
    return consoleAgent(caller.clientId).then((agent) => runConsoleCommand(identity, ...worldArgs, body, agent));
  },
  get_console_result: (_identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null || typeof args.commandId !== "string" ? null : consoleCommandResult(...worldArgs, args.commandId);
  },
  start_world: (identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null ? null : controlSession(identity, "start", ...worldArgs);
  },
  stop_world: (identity, args) => {
    const worldArgs = worldToolArguments(args);
    return worldArgs === null ? null : controlSession(identity, "stop", ...worldArgs);
  },
};

async function callMcpTool(caller: McpCaller, scopes: readonly OAuthScope[], name: string, args: Record<string, unknown>): Promise<Response> {
  const { identity } = caller;
  const tool = mcpTools.find((candidate) => candidate.name === name);
  if (tool === undefined) return mcpToolError(`Unknown tool: ${name}`);
  if (!scopes.includes(tool.scope)) return response(403, { error: "insufficient_scope" });
  if (!hasMcpToolPermission(identity, tool.permission)) return response(403, { error: "forbidden" });
  const apiResponse = await mcpToolCalls[tool.name](identity, args, caller);
  if (apiResponse === null) return mcpToolError("Invalid tool arguments");
  const data = JSON.parse(apiResponse.body || "null") as unknown;
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

function listMcpTools(id: unknown): Response {
  return mcpJson(id, { tools: mcpTools.map((tool) => ({
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }], ...(tool.name === "get_profile" ? { "openai/profile": true } : {}) },
  })) });
}

async function callRemoteMcpTool(request: McpRequest, caller: McpCaller, scopes: readonly OAuthScope[]): Promise<Response> {
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const args = params.arguments !== null && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const name = typeof params.name === "string" ? params.name : "";
  const called = await callMcpTool(caller, scopes, name, args);
  const payload = JSON.parse(called.body || "null") as unknown;
  return called.statusCode === 200 ? mcpJson(request.id, payload) : mcpJson(request.id, { ...mcpResult(payload), isError: true });
}

export async function remoteMcp(event: Event): Promise<Response> {
  const authenticated = await authenticateRemoteMcp(event);
  if (authenticated === null) return mcpUnauthorized();
  const request = jsonBody(event) as McpRequest | null;
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") return mcpError(request?.id ?? null, -32600, "Invalid Request");
  if (request.method === "notifications/initialized") return { statusCode: 202, headers: {}, body: "" };
  if (request.method === "initialize") return initializeMcp(request);
  if (request.method === "tools/list") return listMcpTools(request.id);
  if (request.method === "tools/call") return callRemoteMcpTool(request, authenticated, authenticated.scopes);
  return mcpError(request.id, -32601, "Method not found");
}
