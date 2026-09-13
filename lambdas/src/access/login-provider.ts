import type { LoginPrincipal } from "./login-session.ts";

export type LoginAttempt = Readonly<Record<string, unknown>>;

// A provider verifies only its own credential and translates it into the
// provider-neutral principal consumed by login sessions. It does not resolve
// Spawnpoint identities, roles or linked accounts.
export interface LoginProvider {
  readonly id: string;
  authenticate(attempt: LoginAttempt): Promise<LoginPrincipal | null>;
}

export async function authenticateWith(
  provider: LoginProvider,
  attempt: LoginAttempt,
): Promise<LoginPrincipal | null> {
  const principal = await provider.authenticate(attempt);
  if (principal !== null && principal.provider !== provider.id) {
    throw new Error(`login provider ${provider.id} returned principal for ${principal.provider}`);
  }
  return principal;
}
