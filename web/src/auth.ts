import type { ControlPlaneSnapshot } from "./model";

export type ActiveSession = Readonly<{
  state: "active";
  identity: { id: string; displayName: string; roleId: string; directGrants: string[] };
  role: { id: string; name: string; permissions: string[] } | null;
  profile: { telegramId: string; username: string | null; photoUrl: string | null };
  bootstrap: { state: "unclaimed" } | { state: "claimed"; ownerId: string; telegramId: string; claimedAt: string };
}>;

export type VisitorSession = Readonly<{
  state: "visitor";
  candidate: {
    telegramId: string;
    displayName: string;
    username: string | null;
    photoUrl: string | null;
    status: "OBSERVED" | "REQUESTED" | "DISMISSED";
  };
}>;

export type SpawnpointSession = ActiveSession | VisitorSession;
export type AccessCandidate = Readonly<{
  platformUserId: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  status: "OBSERVED" | "REQUESTED";
  firstSeenAt: string;
  lastSeenAt: string;
  requestedAt: string | null;
}>;
export type AccessIdentity = Readonly<{
  id: string;
  displayName: string;
  roleId: string;
  directGrants: string[];
  links: ReadonlyArray<{ platform: string; value: string; verified: boolean }>;
}>;
export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unconfigured" }
  | { status: "authenticated"; session: SpawnpointSession }
  | { status: "error"; message: string };

const TOKEN_KEY = "spawnpoint.auth.session";
const apiUrl = (import.meta.env.VITE_ACCESS_API_URL ?? "").replace(/\/$/, "");
export const telegramBotUsername = (import.meta.env.VITE_TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");

export function authConfigured(): boolean {
  return apiUrl !== "" && /^[A-Za-z][A-Za-z0-9_]{3,30}bot$/.test(telegramBotUsername);
}

export function telegramLoginRedirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function readToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

function saveToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
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

async function exchangeTelegram(body: { login: Record<string, string> } | { initData: string }): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Telegram could not verify this sign-in. Please start again.");
  const result = await response.json() as { sessionToken?: unknown };
  if (typeof result.sessionToken !== "string") throw new Error("Spawnpoint did not create a valid session.");
  return result.sessionToken;
}

async function loadSession(token: string): Promise<SpawnpointSession> {
  const response = await fetch(`${apiUrl}/session`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error("Your Spawnpoint session expired.");
  return response.json() as Promise<SpawnpointSession>;
}

export async function restoreAuth(): Promise<AuthState> {
  if (!authConfigured()) return { status: "unconfigured" };
  const login = loginPayloadFromQuery();
  if (login !== null) {
    try {
      const token = await exchangeTelegram({ login });
      saveToken(token);
      clearLoginQuery();
      return { status: "authenticated", session: await loadSession(token) };
    } catch (error) {
      clearLoginQuery();
      return { status: "error", message: error instanceof Error ? error.message : "Telegram sign-in failed." };
    }
  }
  const initData = window.Telegram?.WebApp.initData;
  if (initData) {
    try {
      const token = await exchangeTelegram({ initData });
      saveToken(token);
      return { status: "authenticated", session: await loadSession(token) };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "Telegram Mini App sign-in failed." };
    }
  }
  const token = readToken();
  if (token === null) return { status: "signed-out" };
  try {
    return { status: "authenticated", session: await loadSession(token) };
  } catch {
    signOut();
    return { status: "signed-out" };
  }
}

export function signOut(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export function endSession(): void {
  signOut();
  window.location.assign(`${window.location.pathname}#/overview`);
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = readToken();
  if (token === null) throw new Error("Your sign-in session expired.");
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
}

export async function requestAccess(): Promise<void> {
  const response = await authorizedFetch("/access/request", { method: "POST" });
  if (!response.ok) throw new Error("The access request could not be sent.");
}

export async function loadAccessCandidates(): Promise<AccessCandidate[]> {
  const response = await authorizedFetch("/access/candidates");
  if (!response.ok) throw new Error("Access requests could not be loaded.");
  const body = await response.json() as { candidates: AccessCandidate[] };
  return body.candidates;
}

export async function loadControlPlane(): Promise<ControlPlaneSnapshot> {
  const response = await authorizedFetch("/control-plane");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view server status." : "The control-plane state could not be loaded.");
  return response.json() as Promise<ControlPlaneSnapshot>;
}

export async function requestSessionOperation(gameId: string, worldId: string, action: "start" | "stop"): Promise<{ result: "requested" | "already_stopped"; operationId?: string }> {
  const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/${action}`, { method: "POST" });
  const body = await response.json() as { error?: string; result?: "requested" | "already_stopped"; operationId?: string };
  if (!response.ok) {
    const messages: Record<string, string> = {
      forbidden: `Your role cannot ${action} sessions.`,
      unsupported_world: "This world is not connected to a session workflow yet.",
      operation_in_progress: "Another control-plane operation is already running.",
      host_not_unique: "Spawnpoint could not select exactly one compatible host.",
      host_transitioning: "The compute host is already changing state. Refresh and try again shortly.",
    };
    throw new Error(messages[body.error ?? ""] ?? `The ${action} request could not be accepted.`);
  }
  if (!body.result) throw new Error("Spawnpoint returned an invalid operation response.");
  return { result: body.result, ...(body.operationId ? { operationId: body.operationId } : {}) };
}

export async function approveAccessCandidate(telegramId: string, roleId: string): Promise<{ id: string; displayName: string; roleId: string }> {
  const response = await authorizedFetch(`/access/candidates/${telegramId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId }),
  });
  if (!response.ok) throw new Error("This Telegram account could not be approved.");
  const body = await response.json() as { identity: { id: string; displayName: string; roleId: string } };
  return body.identity;
}

export async function dismissAccessCandidate(telegramId: string): Promise<void> {
  const response = await authorizedFetch(`/access/candidates/${telegramId}/dismiss`, { method: "POST" });
  if (!response.ok) throw new Error("This Telegram account could not be dismissed.");
}

export async function loadAccessIdentities(): Promise<AccessIdentity[]> {
  const response = await authorizedFetch("/access/identities");
  if (!response.ok) throw new Error("Users could not be loaded.");
  const body = await response.json() as { identities: AccessIdentity[] };
  return body.identities;
}

export async function updateIdentityRole(identityId: string, roleId: string): Promise<void> {
  const response = await authorizedFetch(`/access/identities/${identityId}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? "You cannot change your own Owner role." : "The role could not be changed.");
}
