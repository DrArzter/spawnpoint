import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const oauthAccessTokenLifetimeSeconds = 15 * 60;
export const oauthAuthorizationCodeLifetimeSeconds = 5 * 60;
export const oauthRefreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;

export const oauthScopes = ["spawnpoint.read", "spawnpoint.operate"] as const;
export type OAuthScope = typeof oauthScopes[number];

export type OAuthAuthorizationRequest = Readonly<{
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: readonly OAuthScope[];
  state: string;
  codeChallenge: string;
}>;

export type OAuthAccessSubject = Readonly<{
  identityId: string;
  clientId: string;
  audience: string;
  scopes: readonly OAuthScope[];
}>;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function key(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`spawnpoint-oauth-${purpose}-v1`).digest();
}

function sign(payload: string, secret: string, purpose: string): string {
  return createHmac("sha256", key(secret, purpose)).update(payload).digest("base64url");
}

function verifiedPayload(token: string, secret: string, purpose: string): Record<string, unknown> | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret, purpose), "base64url");
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function normalizeScopes(value: string | undefined): readonly OAuthScope[] | null {
  const requested = [...new Set((value ?? "").split(/\s+/).filter(Boolean))];
  if (requested.length === 0 || requested.some((scope) => !oauthScopes.includes(scope as OAuthScope))) return null;
  return requested as OAuthScope[];
}

export function issueAuthorizationRequest(
  request: OAuthAuthorizationRequest,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = encode({ v: 1, kind: "oauth_request", ...request, iat: nowSeconds, exp: nowSeconds + oauthAuthorizationCodeLifetimeSeconds });
  return `${payload}.${sign(payload, secret, "request")}`;
}

export function verifyAuthorizationRequest(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): OAuthAuthorizationRequest | null {
  const value = verifiedPayload(token, secret, "request");
  if (
    value?.v !== 1 || value.kind !== "oauth_request" || typeof value.exp !== "number" || value.exp <= nowSeconds ||
    typeof value.clientId !== "string" || typeof value.redirectUri !== "string" || typeof value.resource !== "string" ||
    typeof value.state !== "string" || typeof value.codeChallenge !== "string" || !Array.isArray(value.scopes)
  ) return null;
  const scopes = normalizeScopes(value.scopes.join(" "));
  return scopes === null ? null : {
    clientId: value.clientId,
    redirectUri: value.redirectUri,
    resource: value.resource,
    state: value.state,
    codeChallenge: value.codeChallenge,
    scopes,
  };
}

export function issueOAuthAccessToken(
  subject: OAuthAccessSubject,
  issuer: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = encode({
    v: 1, kind: "oauth_access", iss: issuer, sub: subject.identityId, aud: subject.audience,
    client_id: subject.clientId, scope: subject.scopes.join(" "), iat: nowSeconds,
    exp: nowSeconds + oauthAccessTokenLifetimeSeconds,
  });
  return `${payload}.${sign(payload, secret, "access")}`;
}

export function verifyOAuthAccessToken(
  token: string,
  issuer: string,
  audience: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): OAuthAccessSubject | null {
  const value = verifiedPayload(token, secret, "access");
  if (
    value?.v !== 1 || value.kind !== "oauth_access" || value.iss !== issuer || value.aud !== audience ||
    typeof value.exp !== "number" || value.exp <= nowSeconds || typeof value.sub !== "string" ||
    typeof value.client_id !== "string" || typeof value.scope !== "string"
  ) return null;
  const scopes = normalizeScopes(value.scope);
  return scopes === null ? null : { identityId: value.sub, clientId: value.client_id, audience, scopes };
}

export function issueOpaqueCredential(): Readonly<{ token: string; hash: string }> {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: credentialHash(token) };
}

export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(expectedChallenge)) return false;
  const expected = Buffer.from(expectedChallenge);
  const actual = Buffer.from(pkceChallenge(verifier));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
