import { type LoginProvider, authenticateWith } from "../../access/login-provider.ts";
import { createPasswordLoginProvider, passwordProviderId } from "../../access/password-login-provider.ts";
import { createTelegramLoginProvider } from "../../access/telegram-login-provider.ts";
import { createGoogleLoginProvider, googleProviderId } from "../../access/google-login-provider.ts";
import { type Event, type Response, objectBody, response } from "./http.ts";
import { createLoginSession } from "./login-sessions.ts";
import { passwordCredentials } from "./credentials.ts";
import { telegramOidcClientId, googleOidcClientId, telegramLoginEnabled, googleLoginEnabled, passwordLoginEnabled, passwordRegistrationEnabled } from "./auth-config.ts";
import { botToken } from "./secrets.ts";
import { emailDeliveryProvider } from "./mail.ts";

export async function authenticate(provider: LoginProvider, event: Event): Promise<Response> {
  const attempt = objectBody(event);
  if (attempt === null) return response(400, { error: "invalid_json" });
  const principal = await authenticateWith(provider, attempt);
  if (principal === null) return response(401, { error: `invalid_or_expired_${provider.id}_login` });
  return createLoginSession(principal);
}

export const passwordProvider = createPasswordLoginProvider({ credentials: passwordCredentials });

export const telegramProvider = createTelegramLoginProvider({ oidcClientId: telegramOidcClientId, botToken });

export const googleProvider = createGoogleLoginProvider({ clientId: googleOidcClientId });

// Proof-based providers all link through the same use-case. Password is kept
// separate because linking it creates a new credential and verifies a mailbox;
// Telegram, Google and Discord only need to verify a provider-owned proof.
// A provider that is off is not linkable either: the profile offers only what
// can be signed in with afterwards.
export const proofLinkProviders: ReadonlyMap<string, LoginProvider> = new Map(
  [...(telegramLoginEnabled ? [telegramProvider] : []), ...(googleLoginEnabled ? [googleProvider] : [])]
    .map((provider): [string, LoginProvider] => [provider.id, provider]),
);

// Which ways in this deployment offers, so the panel draws only buttons that
// lead somewhere. Public by nature: it is read before there is a session.
export function loginProviders(): Response {
  return response(200, {
    providers: [
      ...(telegramLoginEnabled ? [telegramProvider.id] : []),
      ...(googleLoginEnabled ? [googleProviderId] : []),
      ...(passwordLoginEnabled ? [passwordProviderId] : []),
    ],
    selfRegistration: passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none" ? [passwordProviderId] : [],
    emailActions: emailDeliveryProvider !== "none",
  });
}

export const loginProviderDisabled = (): Response => response(404, { error: "not_found" });
