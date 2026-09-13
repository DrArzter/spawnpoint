import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export type TelegramProfile = Readonly<{
  telegramId: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
}>;

type TelegramLoginPayload = Readonly<Record<string, unknown>>;

const loginKeys = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"] as const;
const sessionLifetimeSeconds = 12 * 60 * 60;
const loginFreshnessSeconds = 10 * 60;
const telegramOidcIssuer = "https://oauth.telegram.org";
const telegramJwksUrl = `${telegramOidcIssuer}/.well-known/jwks.json`;
const jwksLifetimeMilliseconds = 60 * 60 * 1000;

type TelegramJwk = JsonWebKey & Readonly<{ kid?: string; alg?: string; use?: string }>;
type JwksFetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let cachedJwks: { expiresAt: number; keys: TelegramJwk[] } | undefined;

function equalHex(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

function profileFromValues(values: Readonly<Record<string, string>>): TelegramProfile | null {
  if (!/^[1-9][0-9]{4,19}$/.test(values.id ?? "")) return null;
  const firstName = (values.first_name ?? "").trim();
  const lastName = (values.last_name ?? "").trim();
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || `Telegram ${values.id}`;
  return {
    telegramId: values.id!,
    displayName,
    username: values.username?.trim() || null,
    photoUrl: values.photo_url?.trim() || null,
  };
}

function freshAuthDate(value: string | undefined, nowSeconds: number): boolean {
  const authDate = Number(value);
  return Number.isInteger(authDate) && authDate <= nowSeconds + 30 && nowSeconds - authDate <= loginFreshnessSeconds;
}

export function verifyLoginWidget(payload: TelegramLoginPayload, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramProfile | null {
  const hash = typeof payload.hash === "string" ? payload.hash : "";
  const values: Record<string, string> = {};
  for (const key of loginKeys) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") values[key] = value;
  }
  if (!freshAuthDate(values.auth_date, nowSeconds)) return null;
  const dataCheckString = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return equalHex(expected, hash) ? profileFromValues(values) : null;
}

export function verifyMiniAppInitData(initData: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramProfile | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  params.delete("hash");
  const values = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!freshAuthDate(params.get("auth_date") ?? undefined, nowSeconds)) return null;
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(values.map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex");
  if (!equalHex(expected, hash)) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as Record<string, unknown> | null;
    if (user === null) return null;
    const profileValues: Record<string, string> = {
      id: String(user.id ?? ""),
      first_name: typeof user.first_name === "string" ? user.first_name : "",
      last_name: typeof user.last_name === "string" ? user.last_name : "",
      username: typeof user.username === "string" ? user.username : "",
      photo_url: typeof user.photo_url === "string" ? user.photo_url : "",
    };
    return profileFromValues(profileValues);
  } catch {
    return null;
  }
}

function decodeJsonPart(encoded: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function fetchTelegramJwks(fetcher: JwksFetcher, nowMilliseconds: number, force = false): Promise<TelegramJwk[]> {
  if (!force && cachedJwks !== undefined && cachedJwks.expiresAt > nowMilliseconds) return cachedJwks.keys;
  const response = await fetcher(telegramJwksUrl);
  if (!response.ok) throw new Error("Telegram OIDC keys are unavailable");
  const document = await response.json() as { keys?: unknown };
  if (!Array.isArray(document.keys)) throw new Error("Telegram OIDC returned an invalid JWKS document");
  const keys = document.keys.filter((value): value is TelegramJwk => value !== null && typeof value === "object");
  cachedJwks = { expiresAt: nowMilliseconds + jwksLifetimeMilliseconds, keys };
  return keys;
}

function oidcProfile(claims: Record<string, unknown>): TelegramProfile | null {
  const id = typeof claims.id === "number" && Number.isSafeInteger(claims.id)
    ? String(claims.id)
    : typeof claims.id === "string" ? claims.id : "";
  if (!/^[1-9][0-9]{4,19}$/.test(id)) return null;
  return profileFromValues({
    id,
    first_name: typeof claims.name === "string" ? claims.name : "",
    username: typeof claims.preferred_username === "string" ? claims.preferred_username : "",
    photo_url: typeof claims.picture === "string" ? claims.picture : "",
  });
}

export async function verifyOidcIdToken(
  idToken: string,
  clientId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  fetcher: JwksFetcher = fetch,
): Promise<TelegramProfile | null> {
  const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined || !/^\d+$/.test(clientId)) return null;
  const header = decodeJsonPart(encodedHeader);
  const claims = decodeJsonPart(encodedClaims);
  if (header === null || claims === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const audience = claims.aud;
  const audienceMatches = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  if (
    claims.iss !== telegramOidcIssuer || !audienceMatches ||
    typeof claims.exp !== "number" || claims.exp < nowSeconds ||
    typeof claims.iat !== "number" || claims.iat > nowSeconds + 30 || nowSeconds - claims.iat > loginFreshnessSeconds
  ) return null;

  const nowMilliseconds = nowSeconds * 1000;
  let keys = await fetchTelegramJwks(fetcher, nowMilliseconds);
  let jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (jwk === undefined) {
    keys = await fetchTelegramJwks(fetcher, nowMilliseconds, true);
    jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  }
  if (jwk === undefined) return null;

  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    const valid = verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), createPublicKey({ key: jwk, format: "jwk" }), signature);
    return valid ? oidcProfile(claims) : null;
  } catch {
    return null;
  }
}

function sessionKey(botToken: string): Buffer {
  return createHmac("sha256", botToken).update("spawnpoint-browser-session-v1").digest();
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function issueSessionToken(profile: TelegramProfile, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = base64Url(JSON.stringify({
    v: 1,
    sub: profile.telegramId,
    name: profile.displayName,
    username: profile.username,
    picture: profile.photoUrl,
    iat: nowSeconds,
    exp: nowSeconds + sessionLifetimeSeconds,
    nonce: randomBytes(12).toString("base64url"),
  }));
  const signature = createHmac("sha256", sessionKey(botToken)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, botToken: string, nowSeconds = Math.floor(Date.now() / 1000)): TelegramProfile | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", sessionKey(botToken)).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.exp !== "number" || typeof value.iat !== "number" || value.exp < nowSeconds || value.iat > nowSeconds + 30) return null;
    return profileFromValues({
      id: typeof value.sub === "string" ? value.sub : "",
      first_name: typeof value.name === "string" ? value.name : "",
      username: typeof value.username === "string" ? value.username : "",
      photo_url: typeof value.picture === "string" ? value.picture : "",
    });
  } catch {
    return null;
  }
}
