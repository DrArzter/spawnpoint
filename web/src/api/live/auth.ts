import { describeProviderSignInFailure, describeRegistrationFailure, describeSignInFailure, isLoginProviderId } from "../../lib/signin";
import { ApiError, type AccountProfile, type AuthState, type LinkedLoginAccounts, type LoginOptions, type SpawnpointApi, type SpawnpointSession } from "../contract";
import { request } from "./request";
import { apiUrl, refreshBrowserSession } from "./transport";

const LEGACY_TOKEN_KEY = "spawnpoint.auth.session";
export const telegramOidcClientId = (import.meta.env.VITE_TELEGRAM_OIDC_CLIENT_ID ?? "").trim();
export const googleOidcClientId = (import.meta.env.VITE_GOOGLE_OIDC_CLIENT_ID ?? "").trim();

// Public client ids only decide which sign-in buttons this build can draw.
export function liveAuthConfigured(): boolean {
  return apiUrl !== "";
}

function clearLegacyTokens(): void {
  window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  window.sessionStorage.removeItem(LEGACY_TOKEN_KEY);
}

function clearLoginQuery(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/overview"}`);
}

function loginPayloadFromQuery(): Record<string, string> | null {
  const query = new URLSearchParams(window.location.search);
  if (!query.has("hash") || !query.has("id") || !query.has("auth_date")) return null;
  const allowed = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = query.get(key);
    return value === null ? [] : [[key, value]];
  }));
}

type FailureDescription = (status: number, code: string | undefined) => string;

async function exchangeLogin(path: string, body: unknown, describe: FailureDescription): Promise<void> {
  const result = await request<{ authenticated?: unknown }>(path, { method: "POST", body, renew: false, failure: "Sign-in did not complete. Try again.", describe });
  if (result.authenticated !== true) throw new ApiError("failed", "Spawnpoint did not create a valid session.");
}

function exchangeTelegram(body: { idToken: string } | { login: Record<string, string> } | { initData: string }): Promise<void> {
  return exchangeLogin("/auth/telegram", body, (status, code) => describeProviderSignInFailure("Telegram", status, code));
}

async function sessionFromProviderToken(provider: "telegram" | "google", label: string, idToken: string): Promise<AuthState> {
  try {
    return await sessionFromLogin(`/auth/${provider}`, { idToken }, (status, code) => describeProviderSignInFailure(label, status, code));
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : `${label} sign-in failed.` };
  }
}

async function sessionFromLogin(path: string, body: unknown, describeFailure: FailureDescription): Promise<AuthState> {
  await exchangeLogin(path, body, describeFailure);
  clearLegacyTokens();
  return { status: "authenticated", session: await loadSession() };
}

function accountProfile(profile: Partial<AccountProfile>): AccountProfile {
  const telegramId = profile.telegramId ?? null;
  return {
    provider: profile.provider ?? "telegram",
    platformUserId: profile.platformUserId ?? telegramId ?? "",
    telegramId,
    username: profile.username ?? null,
    email: profile.email ?? null,
    photoUrl: profile.photoUrl ?? null,
  };
}

async function loadSession(): Promise<SpawnpointSession> {
  const parsed = await request<SpawnpointSession & { capabilities?: readonly string[] }>("/session", { renew: false, failure: "Your Spawnpoint session expired.", describe: () => "Your Spawnpoint session expired." });
  if (parsed.state === "active") return { ...parsed, capabilities: parsed.capabilities ?? [], profile: accountProfile(parsed.profile) };
  return { ...parsed, candidate: { ...accountProfile(parsed.candidate), displayName: parsed.candidate.displayName, status: parsed.candidate.status } };
}

function authError(error: unknown, fallback: string): AuthState {
  return { status: "error", message: error instanceof Error ? error.message : fallback };
}

async function restoreLogin(login: Record<string, string>): Promise<AuthState> {
  try {
    await exchangeTelegram({ login });
    clearLegacyTokens();
    return { status: "authenticated", session: await loadSession() };
  } catch (error) {
    return authError(error, "Telegram sign-in failed.");
  } finally {
    clearLoginQuery();
  }
}

async function restoreBrowserSession(): Promise<AuthState | null> {
  try {
    return { status: "authenticated", session: await loadSession() };
  } catch {
    if (!await refreshBrowserSession()) return null;
    try {
      return { status: "authenticated", session: await loadSession() };
    } catch {
      return null;
    }
  }
}

async function restoreMiniApp(initData: string): Promise<AuthState> {
  try {
    await exchangeTelegram({ initData });
    return { status: "authenticated", session: await loadSession() };
  } catch (error) {
    return authError(error, "Telegram Mini App sign-in failed.");
  }
}

async function linkProofAccount(provider: "telegram" | "google", label: string, idToken: string): Promise<void> {
  await request<unknown>(`/me/accounts/${provider}`, {
    method: "POST", body: { idToken }, failure: `${label} could not verify or link this account.`,
    refusals: {
      account_already_linked: `This ${label} account already belongs to another Spawnpoint identity.`,
      provider_already_linked: `This Spawnpoint identity already has a ${label} account.`,
    },
  });
}

export const authApi = {
  async restoreSession(): Promise<AuthState> {
    if (!liveAuthConfigured()) return { status: "unconfigured" };
    const login = loginPayloadFromQuery();
    if (login !== null) return restoreLogin(login);
    clearLegacyTokens();
    const restored = await restoreBrowserSession();
    if (restored !== null) return restored;
    const initData = window.Telegram?.WebApp.initData;
    return initData ? restoreMiniApp(initData) : { status: "signed-out" };
  },

  async loadLoginOptions(): Promise<LoginOptions> {
    try {
      const body = await request<{ providers?: unknown; selfRegistration?: unknown; emailActions?: unknown }>("/auth/providers", { renew: false, failure: "Sign-in options could not be loaded." });
      return {
        providers: Array.isArray(body.providers) ? body.providers.filter(isLoginProviderId) : ["telegram"],
        selfRegistration: Array.isArray(body.selfRegistration) ? body.selfRegistration.filter(isLoginProviderId) : [],
        emailActions: body.emailActions === true,
      };
    } catch {
      return { providers: ["telegram"], selfRegistration: [], emailActions: false };
    }
  },

  exchangeTelegramOidc: (idToken: string) => sessionFromProviderToken("telegram", "Telegram", idToken),
  exchangeGoogleOidc: (idToken: string) => sessionFromProviderToken("google", "Google", idToken),
  signInWithPassword: (email: string, password: string) => sessionFromLogin("/auth/password", { email, password }, describeSignInFailure),

  async registerWithPassword(email: string, password: string, displayName: string, invitationToken?: string) {
    const body = await request<{ result?: unknown; email?: unknown }>("/auth/password/register", {
      method: "POST", renew: false, body: { email, password, displayName, ...(invitationToken ? { invitationToken } : {}) },
      failure: "The account could not be created. Try again.", describe: describeRegistrationFailure,
    });
    if (body.result !== "verification_sent" || typeof body.email !== "string") throw new ApiError("failed", "Spawnpoint returned an invalid registration response.");
    return { result: "verification_sent" as const, email: body.email };
  },

  async resendEmailVerification(email: string, invitationToken?: string): Promise<void> {
    await request<unknown>("/auth/email/verification/resend", {
      method: "POST", renew: false, body: { email, ...(invitationToken ? { invitationToken } : {}) }, failure: "A new verification email could not be sent.",
    });
  },

  verifyEmail: (token: string) => sessionFromLogin("/auth/email/verification", { token }, () => "This verification link is invalid, expired, or has already been used."),

  async requestPasswordReset(email: string): Promise<void> {
    await request<unknown>("/auth/password/forgot", { method: "POST", renew: false, body: { email }, failure: "The reset request could not be sent." });
  },

  async resetPassword(token: string, password: string): Promise<void> {
    await request<unknown>("/auth/password/reset", {
      method: "POST", renew: false, body: { token, password }, failure: "The password could not be reset. Try again.", describe: describeRegistrationFailure,
    });
  },

  async revokeSession(): Promise<void> {
    clearLegacyTokens();
    await request<unknown>("/auth/logout", { method: "POST", renew: false, failure: "Sign-out could not be confirmed." }).catch(() => undefined);
  },

  async loadLinkedAccounts(): Promise<LinkedLoginAccounts> {
    const body = await request<Partial<LinkedLoginAccounts>>("/me/accounts", { failure: "Linked sign-in accounts could not be loaded." });
    return {
      accounts: body.accounts ?? [],
      linkableProviders: body.linkableProviders ?? [],
      passwordManagementAvailable: body.passwordManagementAvailable === true,
    };
  },

  linkTelegram: (idToken: string) => linkProofAccount("telegram", "Telegram", idToken),
  linkGoogle: (idToken: string) => linkProofAccount("google", "Google", idToken),

  async linkPassword(email: string, password: string, displayName: string): Promise<void> {
    await request<unknown>("/me/password", {
      method: "POST", body: { email, password, displayName }, failure: "The account could not be created. Try again.", describe: describeRegistrationFailure,
    });
  },

  async changePassword(email: string, currentPassword: string, password: string): Promise<void> {
    await request<unknown>("/me/password/change", {
      method: "POST", body: { email, currentPassword, password }, failure: "The password could not be changed. Try again.",
      describe: (status, code) => status === 401 ? "The current password is not correct." : describeRegistrationFailure(status, code),
    });
  },
} satisfies Partial<SpawnpointApi>;
