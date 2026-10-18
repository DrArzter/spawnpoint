import { requestBody } from "../../access/request-body.ts";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { normalizeScopes, oauthScopes, issueAuthorizationRequest, verifyAuthorizationRequest, issueOpaqueCredential, oauthAuthorizationCodeLifetimeSeconds, type OAuthScope, oauthRefreshTokenLifetimeSeconds, issueOAuthAccessToken, oauthAccessTokenLifetimeSeconds, credentialHash, verifyPkce } from "../../access/oauth.ts";
import { type Identity } from "../../access/domain.ts";
import { apiUrl, panelUrl } from "./origins.ts";
import { type Event, type Response, response, responseWithHeaders } from "./http.ts";
import { document, tableName } from "./access-store.ts";
import { sessionSigningSecret } from "./secrets.ts";

// --- Remote MCP authorization and transport ---------------------------------
export const oauthResource = `${apiUrl}/mcp`;

export const oauthIssuer = apiUrl;

export const oauthProtectedResourceMetadata = `${apiUrl}/.well-known/oauth-protected-resource/mcp`;

type OAuthClient = Readonly<{
  id: string;
  name: string;
  redirectUris: readonly string[];
}>;

function oauthClientKey(clientId: string): Record<string, string> {
  return { pk: `OAUTH#CLIENT#${clientId}`, sk: "CLIENT" };
}

function oauthCredentialKey(kind: "CODE" | "REFRESH", hash: string): Record<string, string> {
  return { pk: `OAUTH#${kind}#${hash}`, sk: kind };
}

export function jsonBody(event: Event): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const value = JSON.parse(requestBody(event)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function formBody(event: Event): URLSearchParams {
  return new URLSearchParams(requestBody(event));
}

function oauthError(statusCode: number, error: string, description?: string): Response {
  return response(statusCode, { error, ...(description ? { error_description: description } : {}) });
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch { return false; }
}

export async function oauthClient(clientId: string): Promise<OAuthClient | null> {
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(clientId)) return null;
  const item = (await document.send(new GetCommand({ TableName: tableName, Key: oauthClientKey(clientId), ConsistentRead: true }))).Item;
  if (item === undefined || item.status !== "ACTIVE" || typeof item.client_name !== "string" || !Array.isArray(item.redirect_uris)) return null;
  const redirectUris = item.redirect_uris.filter((uri): uri is string => typeof uri === "string");
  return { id: clientId, name: item.client_name, redirectUris };
}

export async function registerOAuthClient(event: Event): Promise<Response> {
  const body = jsonBody(event);
  const name = typeof body?.client_name === "string" ? body.client_name.trim() : "";
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  if (!name || name.length > 80 || redirectUris.length === 0 || redirectUris.length > 8 || redirectUris.some((uri) => !validRedirectUri(uri))) {
    return oauthError(400, "invalid_client_metadata");
  }
  if (body?.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Spawnpoint accepts public PKCE clients only.");
  }
  const clientId = `sp_${randomUUID()}`;
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthClientKey(clientId), status: "ACTIVE", client_name: name, redirect_uris: redirectUris,
    token_endpoint_auth_method: "none", created_at: new Date().toISOString(),
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return response(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

export async function startOAuthAuthorization(event: Event): Promise<Response> {
  const query = event.queryStringParameters ?? {};
  const client = await oauthClient(query.client_id ?? "");
  if (client === null) return oauthError(400, "invalid_request", "Unknown OAuth client.");
  const redirectUri = query.redirect_uri ?? "";
  const scopes = normalizeScopes(query.scope ?? oauthScopes.join(" "));
  if (
    query.response_type !== "code" || !client.redirectUris.includes(redirectUri) || query.resource !== oauthResource ||
    query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? "") ||
    typeof query.state !== "string" || query.state.length < 8 || query.state.length > 1024 || scopes === null
  ) return oauthError(400, "invalid_request");
  const request = issueAuthorizationRequest({
    clientId: client.id, redirectUri, resource: oauthResource, scopes, state: query.state,
    codeChallenge: query.code_challenge!,
  }, await sessionSigningSecret());
  const location = `${panelUrl}/#/connect?request=${encodeURIComponent(request)}`;
  return responseWithHeaders(302, null, { location, "cache-control": "no-store" });
}

function oauthRedirect(redirectUri: string, values: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

export async function completeOAuthAuthorization(identity: Identity, event: Event): Promise<Response> {
  const body = jsonBody(event);
  const requestToken = typeof body?.request === "string" ? body.request : "";
  const request = verifyAuthorizationRequest(requestToken, await sessionSigningSecret());
  if (request === null) return oauthError(400, "invalid_request");
  const client = await oauthClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) return oauthError(400, "invalid_request");
  if (body?.approved !== true) {
    return response(200, { redirect_to: oauthRedirect(request.redirectUri, { error: "access_denied", state: request.state }) });
  }
  const code = issueOpaqueCredential();
  const now = Math.floor(Date.now() / 1000);
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthCredentialKey("CODE", code.hash), status: "ACTIVE", identity_id: identity.id,
    client_id: request.clientId, redirect_uri: request.redirectUri, resource: request.resource,
    scope: request.scopes.join(" "), code_challenge: request.codeChallenge,
    created_at: new Date(now * 1000).toISOString(), expires_at: now + oauthAuthorizationCodeLifetimeSeconds,
    ttl: now + oauthAuthorizationCodeLifetimeSeconds,
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return response(200, { redirect_to: oauthRedirect(request.redirectUri, { code: code.token, state: request.state, iss: oauthIssuer }) });
}

export async function inspectOAuthAuthorization(event: Event): Promise<Response> {
  const body = jsonBody(event);
  const request = verifyAuthorizationRequest(typeof body?.request === "string" ? body.request : "", await sessionSigningSecret());
  if (request === null) return oauthError(400, "invalid_request");
  const client = await oauthClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) return oauthError(400, "invalid_request");
  return response(200, { client: { name: client.name, redirectOrigin: new URL(request.redirectUri).origin }, scopes: request.scopes });
}

async function issueOAuthTokens(subject: { identityId: string; clientId: string; resource: string; scopes: readonly OAuthScope[] }): Promise<Response> {
  const secret = await sessionSigningSecret();
  const refresh = issueOpaqueCredential();
  const now = Math.floor(Date.now() / 1000);
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthCredentialKey("REFRESH", refresh.hash), status: "ACTIVE", identity_id: subject.identityId,
    client_id: subject.clientId, resource: subject.resource, scope: subject.scopes.join(" "),
    created_at: new Date(now * 1000).toISOString(), expires_at: now + oauthRefreshTokenLifetimeSeconds,
    ttl: now + oauthRefreshTokenLifetimeSeconds,
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return responseWithHeaders(200, {
    access_token: issueOAuthAccessToken({
      identityId: subject.identityId, clientId: subject.clientId, audience: subject.resource, scopes: subject.scopes,
    }, oauthIssuer, secret, now),
    token_type: "Bearer", expires_in: oauthAccessTokenLifetimeSeconds,
    refresh_token: refresh.token, scope: subject.scopes.join(" "),
  }, { "cache-control": "no-store", pragma: "no-cache" });
}

async function exchangeAuthorizationCode(params: URLSearchParams): Promise<Response> {
  const code = params.get("code") ?? "";
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: oauthCredentialKey("CODE", credentialHash(code)), ConsistentRead: true,
  }))).Item;
  const now = Math.floor(Date.now() / 1000);
  if (
    item?.status !== "ACTIVE" || typeof item.expires_at !== "number" || item.expires_at <= now ||
    item.client_id !== params.get("client_id") || item.redirect_uri !== params.get("redirect_uri") ||
    item.resource !== params.get("resource") || typeof item.code_challenge !== "string" || !verifyPkce(params.get("code_verifier") ?? "", item.code_challenge) ||
    typeof item.identity_id !== "string" || typeof item.client_id !== "string" || typeof item.resource !== "string" || typeof item.scope !== "string"
  ) return oauthError(400, "invalid_grant");
  const scopes = normalizeScopes(item.scope);
  if (scopes === null) return oauthError(400, "invalid_grant");
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: oauthCredentialKey("CODE", credentialHash(code)),
      UpdateExpression: "SET #status = :used, used_at = :now",
      ConditionExpression: "#status = :active AND expires_at > :epoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":used": "USED", ":active": "ACTIVE", ":now": new Date().toISOString(), ":epoch": now },
    }));
  } catch { return oauthError(400, "invalid_grant"); }
  return issueOAuthTokens({ identityId: item.identity_id, clientId: item.client_id, resource: item.resource, scopes });
}

async function rotateRefreshToken(params: URLSearchParams): Promise<Response> {
  const token = params.get("refresh_token") ?? "";
  const hash = credentialHash(token);
  const requestedResource = params.get("resource");
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: oauthCredentialKey("REFRESH", hash), ConsistentRead: true,
  }))).Item;
  const now = Math.floor(Date.now() / 1000);
  if (
    item?.status !== "ACTIVE" || typeof item.expires_at !== "number" || item.expires_at <= now ||
    item.client_id !== params.get("client_id") || (requestedResource !== null && item.resource !== requestedResource) ||
    typeof item.identity_id !== "string" || typeof item.client_id !== "string" || typeof item.resource !== "string" || typeof item.scope !== "string"
  ) return oauthError(400, "invalid_grant");
  const scopes = normalizeScopes(item.scope);
  if (scopes === null) return oauthError(400, "invalid_grant");
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: oauthCredentialKey("REFRESH", hash),
      UpdateExpression: "SET #status = :rotated, rotated_at = :now",
      ConditionExpression: "#status = :active AND expires_at > :epoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":rotated": "ROTATED", ":active": "ACTIVE", ":now": new Date().toISOString(), ":epoch": now },
    }));
  } catch { return oauthError(400, "invalid_grant"); }
  return issueOAuthTokens({ identityId: item.identity_id, clientId: item.client_id, resource: item.resource, scopes });
}

export async function oauthToken(event: Event): Promise<Response> {
  const params = formBody(event);
  const grant = params.get("grant_type");
  if (grant === "authorization_code") return exchangeAuthorizationCode(params);
  if (grant === "refresh_token") return rotateRefreshToken(params);
  return oauthError(400, "unsupported_grant_type");
}

export async function revokeOAuthToken(event: Event): Promise<Response> {
  const params = formBody(event);
  const token = params.get("token") ?? "";
  const clientId = params.get("client_id") ?? "";
  const key = oauthCredentialKey("REFRESH", credentialHash(token));
  const item = (await document.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
  if (item?.client_id === clientId && item.status === "ACTIVE") {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName, Key: key,
        UpdateExpression: "SET #status = :revoked, revoked_at = :now",
        ConditionExpression: "#status = :active AND client_id = :client",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "REVOKED", ":active": "ACTIVE", ":client": clientId, ":now": new Date().toISOString() },
      }));
    } catch { /* Revocation is deliberately idempotent and enumeration-safe. */ }
  }
  return responseWithHeaders(200, null, { "cache-control": "no-store" });
}

export function oauthServerMetadata(): Response {
  return response(200, {
    issuer: oauthIssuer,
    authorization_endpoint: `${oauthIssuer}/oauth/authorize`,
    token_endpoint: `${oauthIssuer}/oauth/token`,
    revocation_endpoint: `${oauthIssuer}/oauth/revoke`,
    registration_endpoint: `${oauthIssuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: oauthScopes,
  });
}

export function oauthResourceMetadata(): Response {
  return response(200, { resource: oauthResource, authorization_servers: [oauthIssuer], scopes_supported: oauthScopes });
}
