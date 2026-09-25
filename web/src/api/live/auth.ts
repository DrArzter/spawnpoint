import { describeProviderSignInFailure, describeRegistrationFailure, describeSignInFailure, isLoginProviderId } from "../../lib/signin";
import { apiFailure, type AccountProfile, type AuthState, type LinkedLoginAccounts, type LoginOptions, type SpawnpointApi, type SpawnpointSession } from "../contract";
import { apiUrl, authorizedFetch, publicPost, refreshBrowserSession } from "./transport";

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

async function exchangeLogin(path: string, body: unknown, describeFailure: FailureDescription): Promise<void> {
  const response = await publicPost(path, body);
  if (!response.ok) {
    const parsed = await response.json().catch(() => null) as { error?: unknown } | null;
    const code = typeof parsed?.error === "string" ? parsed.error : undefined;
    throw await apiFailure(response, describeFailure(response.status, code), parsed);
  }
  const result = await response.json() as { authenticated?: unknown };
  if (result.authenticated !== true) throw new Error("Spawnpoint did not create a valid session.");
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
  const response = await fetch(`${apiUrl}/session`, { credentials: "include" });
  if (!response.ok) throw new Error("Your Spawnpoint session expired.");
  const parsed = await response.json() as SpawnpointSession & { capabilities?: readonly string[] };
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
  const response = await authorizedFetch(`/me/accounts/${provider}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  if (response.ok) return;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : undefined;
  let message = `${label} could not verify or link this account.`;
  if (code === "account_already_linked") message = `This ${label} account already belongs to another Spawnpoint identity.`;
  else if (code === "provider_already_linked") message = `This Spawnpoint identity already has a ${label} account.`;
  throw await apiFailure(response, message, body);
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
      const response = await fetch(`${apiUrl}/auth/providers`, { credentials: "include" });
      if (!response.ok) return { providers: ["telegram"], selfRegistration: [], emailActions: false };
      const body = await response.json() as { providers?: unknown; selfRegistration?: unknown; emailActions?: unknown };
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
    const response = await publicPost("/auth/password/register", { email, password, displayName, ...(invitationToken ? { invitationToken } : {}) });
    const body = await response.json().catch(() => null) as { result?: unknown; email?: unknown; error?: unknown } | null;
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : undefined;
      throw await apiFailure(response, describeRegistrationFailure(response.status, code), body);
    }
    if (body?.result !== "verification_sent" || typeof body.email !== "string") throw new Error("Spawnpoint returned an invalid registration response.");
    return { result: "verification_sent" as const, email: body.email };
  },

  async resendEmailVerification(email: string, invitationToken?: string): Promise<void> {
    const response = await publicPost("/auth/email/verification/resend", { email, ...(invitationToken ? { invitationToken } : {}) });
    if (!response.ok) throw await apiFailure(response, "A new verification email could not be sent.");
  },

  verifyEmail: (token: string) => sessionFromLogin("/auth/email/verification", { token }, () => "This verification link is invalid, expired, or has already been used."),

  async requestPasswordReset(email: string): Promise<void> {
    const response = await publicPost("/auth/password/forgot", { email });
    if (!response.ok) throw await apiFailure(response, "The reset request could not be sent.");
  },

  async resetPassword(token: string, password: string): Promise<void> {
    const response = await publicPost("/auth/password/reset", { token, password });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      const code = typeof body?.error === "string" ? body.error : undefined;
      throw await apiFailure(response, describeRegistrationFailure(response.status, code), body);
    }
  },

  async revokeSession(): Promise<void> {
    clearLegacyTokens();
    await fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
  },

  async loadLinkedAccounts(): Promise<LinkedLoginAccounts> {
    const response = await authorizedFetch("/me/accounts");
    if (!response.ok) throw await apiFailure(response, "Linked sign-in accounts could not be loaded.");
    const body = await response.json() as Partial<LinkedLoginAccounts>;
    return {
      accounts: body.accounts ?? [],
      linkableProviders: body.linkableProviders ?? [],
      passwordManagementAvailable: body.passwordManagementAvailable === true,
    };
  },

  linkTelegram: (idToken: string) => linkProofAccount("telegram", "Telegram", idToken),
  linkGoogle: (idToken: string) => linkProofAccount("google", "Google", idToken),

  async linkPassword(email: string, password: string, displayName: string): Promise<void> {
    const response = await authorizedFetch("/me/password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, displayName }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      const code = typeof body?.error === "string" ? body.error : undefined;
      throw await apiFailure(response, describeRegistrationFailure(response.status, code), body);
    }
  },

  async changePassword(email: string, currentPassword: string, password: string): Promise<void> {
    const response = await authorizedFetch("/me/password/change", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, currentPassword, password }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      const code = typeof body?.error === "string" ? body.error : undefined;
      const message = response.status === 401 ? "The current password is not correct." : describeRegistrationFailure(response.status, code);
      throw await apiFailure(response, message, body);
    }
  },
} satisfies Partial<SpawnpointApi>;
