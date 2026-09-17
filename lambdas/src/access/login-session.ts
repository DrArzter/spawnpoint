import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const accessTokenLifetimeSeconds = 15 * 60;
export const refreshSessionLifetimeSeconds = 30 * 24 * 60 * 60;
export const refreshCookieName = "spawnpoint.refresh";

// What a provider vouches for. `username` is the handle on that provider and
// `email` the address it verified or was given; either may be absent, and
// neither is the subject, which is the provider's own stable id.
export type LoginPrincipal = Readonly<{
  provider: string;
  subject: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  email: string | null;
}>;

export type AccessSubject = Readonly<{
  loginSessionId: string;
  principal: LoginPrincipal;
}>;

export type RefreshCredential = Readonly<{
  loginSessionId: string;
  token: string;
  tokenHash: string;
}>;

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessTokenKey(signingSecret: string): Buffer {
  return createHmac("sha256", signingSecret).update("spawnpoint-access-token-v2").digest();
}

export function issueAccessToken(
  principal: LoginPrincipal,
  loginSessionId: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = encodedJson({
    v: 2,
    kind: "access",
    sid: loginSessionId,
    provider: principal.provider,
    sub: principal.subject,
    name: principal.displayName,
    username: principal.username,
    picture: principal.photoUrl,
    email: principal.email,
    iat: nowSeconds,
    exp: nowSeconds + accessTokenLifetimeSeconds,
  });
  const signature = createHmac("sha256", accessTokenKey(signingSecret)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAccessToken(
  token: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AccessSubject | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", accessTokenKey(signingSecret)).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.v !== 2 || value.kind !== "access" ||
      typeof value.sid !== "string" || !/^[0-9a-f-]{36}$/.test(value.sid) ||
      typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(value.provider) ||
      typeof value.sub !== "string" || value.sub.length < 1 || value.sub.length > 255 ||
      typeof value.name !== "string" || value.name.length < 1 || value.name.length > 255 ||
      typeof value.exp !== "number" || value.exp <= nowSeconds ||
      typeof value.iat !== "number" || value.iat > nowSeconds + 30
    ) return null;
    return {
      loginSessionId: value.sid,
      principal: {
        provider: value.provider,
        subject: value.sub,
        displayName: value.name,
        username: typeof value.username === "string" && value.username !== "" ? value.username : null,
        photoUrl: typeof value.picture === "string" && value.picture !== "" ? value.picture : null,
        email: typeof value.email === "string" && value.email !== "" ? value.email : null,
      },
    };
  } catch {
    return null;
  }
}

export function issueRefreshCredential(loginSessionId: string = randomUUID()): RefreshCredential {
  const secret = randomBytes(32).toString("base64url");
  return {
    loginSessionId,
    token: `${loginSessionId}.${secret}`,
    tokenHash: createHmac("sha256", "spawnpoint-refresh-credential-v1").update(secret).digest("base64url"),
  };
}

export function parseRefreshCredential(token: string): Omit<RefreshCredential, "token"> | null {
  const [loginSessionId, secret, extra] = token.split(".");
  if (!loginSessionId || !secret || extra !== undefined || !/^[0-9a-f-]{36}$/.test(loginSessionId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return {
    loginSessionId,
    tokenHash: createHmac("sha256", "spawnpoint-refresh-credential-v1").update(secret).digest("base64url"),
  };
}

export function equalRefreshHashes(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function refreshCookie(token: string, sameSite: "Strict" | "None"): string {
  return `${refreshCookieName}=${token}; Path=/auth; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${refreshSessionLifetimeSeconds}`;
}

export function expiredRefreshCookie(sameSite: "Strict" | "None"): string {
  return `${refreshCookieName}=; Path=/auth; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=0`;
}
