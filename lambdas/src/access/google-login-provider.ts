import type { LoginPrincipal } from "./login-session.ts";
import type { LoginAttempt, LoginProvider } from "./login-provider.ts";
import { verifyIdToken, type JwksFetcher, type OidcClaims, type OidcIssuer } from "./oidc.ts";

export const googleProviderId = "google";

// From https://accounts.google.com/.well-known/openid-configuration, and the
// server-side verification guide, which says Google signs tokens under both
// spellings of its issuer.
export const googleIssuer: OidcIssuer = {
  name: "Google",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
};

/** An OAuth client id from the Google Cloud console; nothing else is one. */
export const GOOGLE_CLIENT_ID = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/;

/**
 * What a verified Google token says about the person, in the panel's terms.
 *
 * The subject is `sub`, Google's stable account id, never the email: people
 * change addresses and keep accounts. The email is carried only when Google
 * vouches for it, because an unverified address is a claim anyone can type.
 */
export function googlePrincipal(claims: OidcClaims): LoginPrincipal | null {
  const subject = typeof claims.sub === "string" && /^\d{1,255}$/.test(claims.sub) ? claims.sub : null;
  if (subject === null) return null;
  const email = typeof claims.email === "string" && claims.email_verified === true && claims.email.includes("@")
    ? claims.email.trim().toLowerCase()
    : null;
  const name = [claims.name, claims.given_name].find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim()
    ?? email?.split("@")[0]
    ?? "Google user";
  const photoUrl = typeof claims.picture === "string" && claims.picture.startsWith("https://") ? claims.picture : null;
  return { provider: googleProviderId, subject, displayName: name, username: null, photoUrl, email };
}

type GoogleLoginProviderDependencies = Readonly<{
  clientId: string;
  nowSeconds?(): number;
  fetcher?: JwksFetcher;
}>;

/**
 * Sign in with Google, as one more proof-based adapter (ADR-0045, ADR-0057).
 * The browser gets an ID token from Google Identity Services and hands it
 * here; this checks it is Google's, is for this client, is fresh, and turns it
 * into a principal. No client secret exists anywhere in this flow.
 */
export function createGoogleLoginProvider(dependencies: GoogleLoginProviderDependencies): LoginProvider {
  return {
    id: googleProviderId,
    async authenticate(attempt: LoginAttempt): Promise<LoginPrincipal | null> {
      if (typeof attempt.idToken !== "string" || !GOOGLE_CLIENT_ID.test(dependencies.clientId)) return null;
      const claims = await verifyIdToken(googleIssuer, attempt.idToken, dependencies.clientId, dependencies.nowSeconds?.(), dependencies.fetcher);
      return claims === null ? null : googlePrincipal(claims);
    },
  };
}
