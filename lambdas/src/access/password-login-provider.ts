import { randomBytes } from "node:crypto";

import type { LoginPrincipal } from "./login-session.ts";
import type { LoginAttempt, LoginProvider } from "./login-provider.ts";
import {
  hashPassword,
  normalizeEmail,
  passwordMaximumLength,
  signInLocked,
  verifyPassword,
  type SignInGuard,
} from "./password-credential.ts";

export const passwordProviderId = "password";

export type PasswordCredential = Readonly<{
  subject: string;
  email: string;
  displayName: string;
  passwordHash: string;
  guard: SignInGuard;
}>;

// The store keeps credentials by normalized email. The provider never sees a
// table: it asks for one credential and reports what the attempt did to it.
export type PasswordCredentialStore = Readonly<{
  find(email: string): Promise<PasswordCredential | null>;
  /** Persist one failed attempt without losing concurrent failures. */
  recordFailure(email: string, observed: SignInGuard, nowSeconds: number): Promise<void>;
  recordSuccess(email: string): Promise<void>;
}>;

type PasswordLoginProviderDependencies = Readonly<{
  credentials: PasswordCredentialStore;
  nowSeconds?(): number;
}>;

// The subject is the credential's own id, never the address, so an email can
// be corrected or verified later without the identity behind it changing.
export function passwordPrincipal(credential: Pick<PasswordCredential, "subject" | "email" | "displayName">): LoginPrincipal {
  return {
    provider: passwordProviderId,
    subject: credential.subject,
    displayName: credential.displayName,
    username: null,
    photoUrl: null,
    email: credential.email,
  };
}

// A guess against an address nobody registered, or one that is locked, is
// verified against a hash of nothing. The reply then takes the same time as a
// guess against a real credential, so timing does not say whether the address
// exists.
let decoyHash: Promise<string> | undefined;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString("base64url"));
  return decoyHash;
}

export function createPasswordLoginProvider(dependencies: PasswordLoginProviderDependencies): LoginProvider {
  return {
    id: passwordProviderId,
    async authenticate(attempt: LoginAttempt): Promise<LoginPrincipal | null> {
      const email = normalizeEmail(attempt.email);
      const password = attempt.password;
      if (email === null || typeof password !== "string" || password.length === 0 || password.length > passwordMaximumLength) return null;
      const nowSeconds = dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
      const credential = await dependencies.credentials.find(email);
      if (credential === null || signInLocked(credential.guard, nowSeconds)) {
        await verifyPassword(password, await decoy());
        return null;
      }
      if (!await verifyPassword(password, credential.passwordHash)) {
        await dependencies.credentials.recordFailure(email, credential.guard, nowSeconds);
        return null;
      }
      // A clean guard is left alone: a write per sign-in would be a write that
      // records nothing.
      if (credential.guard.failedSignIns > 0 || credential.guard.lockedUntilEpochSeconds !== null) {
        await dependencies.credentials.recordSuccess(email);
      }
      return passwordPrincipal(credential);
    },
  };
}
