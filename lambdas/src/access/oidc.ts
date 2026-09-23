import { createPublicKey, verify } from "node:crypto";

/**
 * The part of OpenID Connect that is the same for every issuer: an RS256 ID
 * token, checked against the issuer's published keys and against what we were
 * expecting — who signed it, who it is for, and when. What a verified token
 * *means* is each provider's own business; this returns the claims and stops.
 *
 * Telegram and Google both come through here. The two differ in what they put
 * in the claims and in what a client id looks like, and in nothing else.
 */

export type OidcJwk = JsonWebKey & Readonly<{ kid?: string; alg?: string; use?: string }>;
export type JwksFetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export type OidcClaims = Readonly<Record<string, unknown>>;

export type OidcIssuer = Readonly<{
  /** For error messages: "Telegram", "Google". */
  name: string;
  /** Every `iss` value the provider is known to emit. Google emits two. */
  issuers: readonly string[];
  jwksUrl: string;
}>;

const jwksLifetimeMilliseconds = 60 * 60 * 1000;
// A sign-in is a moment, not a bearer credential: an ID token older than this
// is refused even if it has not expired, so a leaked one is not a key.
const loginFreshnessSeconds = 10 * 60;
const jwksCaches = new Map<string, { expiresAt: number; keys: OidcJwk[] }>();

export function decodeJsonPart(encoded: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function fetchJwks(issuer: OidcIssuer, fetcher: JwksFetcher, nowMilliseconds: number, force = false): Promise<OidcJwk[]> {
  const cached = jwksCaches.get(issuer.jwksUrl);
  if (!force && cached !== undefined && cached.expiresAt > nowMilliseconds) return cached.keys;
  const response = await fetcher(issuer.jwksUrl);
  if (!response.ok) throw new Error(`${issuer.name} OIDC keys are unavailable`);
  const document = await response.json() as { keys?: unknown };
  if (!Array.isArray(document.keys)) throw new Error(`${issuer.name} OIDC returned an invalid JWKS document`);
  const keys = document.keys.filter((value): value is OidcJwk => value !== null && typeof value === "object");
  jwksCaches.set(issuer.jwksUrl, { expiresAt: nowMilliseconds + jwksLifetimeMilliseconds, keys });
  return keys;
}

/**
 * The claims of a token this issuer signed for this client, fresh and unexpired;
 * null for anything else, and null is the only failure. A caller cannot tell a
 * forged token from a stale one, and neither gets in.
 */
export async function verifyIdToken(
  issuer: OidcIssuer,
  idToken: string,
  clientId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  fetcher: JwksFetcher = fetch,
): Promise<OidcClaims | null> {
  const [encodedHeader, encodedClaims, encodedSignature, extra] = idToken.split(".");
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined || clientId === "") return null;
  const header = decodeJsonPart(encodedHeader);
  const claims = decodeJsonPart(encodedClaims);
  if (header === null || claims === null || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const audience = claims.aud;
  const audienceMatches = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  if (
    typeof claims.iss !== "string" || !issuer.issuers.includes(claims.iss) || !audienceMatches ||
    typeof claims.exp !== "number" || claims.exp < nowSeconds ||
    typeof claims.iat !== "number" || claims.iat > nowSeconds + 30 || nowSeconds - claims.iat > loginFreshnessSeconds
  ) return null;

  // A key we do not know may be a rotation since we last looked, so the
  // published set is read once more before the token is called unsigned.
  const nowMilliseconds = nowSeconds * 1000;
  let keys = await fetchJwks(issuer, fetcher, nowMilliseconds);
  let jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (jwk === undefined) {
    keys = await fetchJwks(issuer, fetcher, nowMilliseconds, true);
    jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  }
  if (jwk === undefined) return null;

  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    const valid = verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), createPublicKey({ key: jwk, format: "jwk" }), signature);
    return valid ? claims : null;
  } catch {
    return null;
  }
}
