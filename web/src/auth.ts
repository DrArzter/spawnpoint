import type { ControlPlaneSnapshot } from "./model";
import { demo, demoEnabled, demoLatency, demoSession, leaveDemo } from "./demo";

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
export type AccessRole = Readonly<{
  id: string;
  name: string;
  description: string;
  permissions: string[];
  system: boolean;
}>;
export type SubscriptionState = Record<string, boolean>;
export type InvitationRecipient = Readonly<{
  id: string;
  displayName: string;
  delivery: "ready" | "notifications_off" | "bot_unavailable";
}>;
export type InvitationSummary = Readonly<{
  id: string;
  audience: "broadcast" | "direct";
  status: "READY" | "DELIVERING" | "DELIVERED" | "PARTIAL" | "FAILED" | "NO_RECIPIENTS" | "PUBLISH_FAILED";
  recipientCount: number | null;
  targetCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  createdAt: string;
}>;
export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unconfigured" }
  | { status: "authenticated"; session: SpawnpointSession }
  | { status: "error"; message: string };

const LEGACY_TOKEN_KEY = "spawnpoint.auth.session";
const apiUrl = (import.meta.env.VITE_ACCESS_API_URL ?? "").replace(/\/$/, "");
export const telegramOidcClientId = (import.meta.env.VITE_TELEGRAM_OIDC_CLIENT_ID ?? "").trim();
let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function authConfigured(): boolean {
  return apiUrl !== "" && (Boolean(window.Telegram?.WebApp.initData) || /^[1-9][0-9]+$/.test(telegramOidcClientId));
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

async function exchangeTelegram(body: { idToken: string } | { login: Record<string, string> } | { initData: string }): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Telegram could not verify this sign-in. Please start again.");
  const result = await response.json() as { accessToken?: unknown };
  if (typeof result.accessToken !== "string") throw new Error("Spawnpoint did not create a valid session.");
  return result.accessToken;
}

export async function exchangeTelegramOidc(idToken: string): Promise<AuthState> {
  try {
    const token = await exchangeTelegram({ idToken });
    accessToken = token;
    clearLegacyTokens();
    return { status: "authenticated", session: await loadSession(token) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Telegram OIDC sign-in failed." };
  }
}

async function loadSession(token: string): Promise<SpawnpointSession> {
  const response = await fetch(`${apiUrl}/session`, {
    headers: { authorization: `Bearer ${token}` },
    credentials: "include",
  });
  if (!response.ok) throw new Error("Your Spawnpoint session expired.");
  return response.json() as Promise<SpawnpointSession>;
}

async function requestRefresh(): Promise<string | null> {
  const response = await fetch(`${apiUrl}/auth/refresh`, { method: "POST", credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === "refresh_credential_rotated") {
      const retry = await fetch(`${apiUrl}/auth/refresh`, { method: "POST", credentials: "include" });
      if (retry.ok) {
        const retried = await retry.json() as { accessToken?: unknown };
        return typeof retried.accessToken === "string" ? retried.accessToken : null;
      }
    }
    return null;
  }
  const result = await response.json() as { accessToken?: unknown };
  return typeof result.accessToken === "string" ? result.accessToken : null;
}

async function refreshAccessToken(): Promise<string | null> {
  refreshPromise ??= requestRefresh().then((token) => {
    accessToken = token;
    return token;
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function restoreAuth(): Promise<AuthState> {
  if (demoEnabled) return { status: "authenticated", session: demoSession };
  if (!authConfigured()) return { status: "unconfigured" };
  const login = loginPayloadFromQuery();
  if (login !== null) {
    try {
      const token = await exchangeTelegram({ login });
      accessToken = token;
      clearLegacyTokens();
      clearLoginQuery();
      return { status: "authenticated", session: await loadSession(token) };
    } catch (error) {
      clearLoginQuery();
      return { status: "error", message: error instanceof Error ? error.message : "Telegram sign-in failed." };
    }
  }
  clearLegacyTokens();
  const refreshed = await refreshAccessToken();
  if (refreshed !== null) {
    try {
      return { status: "authenticated", session: await loadSession(refreshed) };
    } catch {
      accessToken = null;
    }
  }
  const initData = window.Telegram?.WebApp.initData;
  if (initData) {
    try {
      const token = await exchangeTelegram({ initData });
      accessToken = token;
      return { status: "authenticated", session: await loadSession(token) };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "Telegram Mini App sign-in failed." };
    }
  }
  return { status: "signed-out" };
}

export function signOut(): void {
  accessToken = null;
  clearLegacyTokens();
}

export async function endSession(): Promise<void> {
  if (demoEnabled) { leaveDemo(); return; }
  signOut();
  try {
    await fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include" });
  } finally {
    window.location.assign(`${window.location.pathname}#/`);
  }
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = accessToken ?? await refreshAccessToken();
  if (token === null) throw new Error("Your sign-in session expired.");
  const send = (bearer: string) => fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
  const first = await send(token);
  if (first.status !== 401) return first;
  accessToken = null;
  const refreshed = await refreshAccessToken();
  return refreshed === null ? first : send(refreshed);
}

export async function requestAccess(): Promise<void> {
  if (demoEnabled) return;
  const response = await authorizedFetch("/access/request", { method: "POST" });
  if (!response.ok) throw new Error("The access request could not be sent.");
}

export async function loadAccessCandidates(): Promise<AccessCandidate[]> {
  if (demoEnabled) { await demoLatency(); return demo.candidates(); }
  const response = await authorizedFetch("/access/candidates");
  if (!response.ok) throw new Error("Access requests could not be loaded.");
  const body = await response.json() as { candidates: AccessCandidate[] };
  return body.candidates;
}

export async function loadControlPlane(): Promise<ControlPlaneSnapshot> {
  if (demoEnabled) { await demoLatency(); return demo.snapshot(); }
  const response = await authorizedFetch("/control-plane");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view server status." : "The control-plane state could not be loaded.");
  return response.json() as Promise<ControlPlaneSnapshot>;
}

export async function requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }> {
  if (demoEnabled) { await demoLatency(); return demo.packLink(gameId, worldId); }
  const response = await authorizedFetch(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/pack`,
  );
  const body = await response.json() as { error?: string; release?: string; url?: string };
  if (!response.ok || body.url === undefined || body.release === undefined) {
    const messages: Record<string, string> = {
      forbidden: "Your role cannot read this world's connection details.",
      no_release_pointer: "This world has no release yet, so there is no pack to install.",
      no_release_selected: "This world's release pointer names no release yet.",
      no_pack_published: "This release was published before packs existed. Ask the owner to publish one.",
    };
    throw new Error(messages[body.error ?? ""] ?? "The pack link could not be created.");
  }
  return { release: body.release, url: body.url };
}

export async function requestCreateWorld(
  gameId: string,
  presetId: string,
  displayName: string,
  release: string,
): Promise<{ id: string; displayName: string }> {
  if (demoEnabled) { await demoLatency(); return demo.createWorld(gameId, presetId, displayName, release); }
  const response = await authorizedFetch(
    `/games/${encodeURIComponent(gameId)}/presets/${encodeURIComponent(presetId)}/worlds`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName, release }) },
  );
  const body = await response.json() as { error?: string; world?: { id: string; displayName: string } };
  if (!response.ok || body.world === undefined) {
    const messages: Record<string, string> = {
      forbidden: "Your role cannot create worlds.",
      invalid_world_name: "Enter a name between 1 and 80 characters.",
      preset_release_not_ready: "This preset has no ready release yet.",
      release_not_available: "The selected release is no longer available. Refresh and try again.",
    };
    throw new Error(messages[body.error ?? ""] ?? "The world could not be created.");
  }
  return body.world;
}

export type BackupEntry = { key: string; archiveName: string; checksum: string; generationId: string | null; sizeBytes: number; storedAt: string };
export type BackupInventory = { entries: BackupEntry[]; unverified: number; truncated: boolean };

export async function loadBackups(gameId: string, worldId: string): Promise<BackupInventory> {
  if (demoEnabled) { await demoLatency(); return demo.backups(gameId, worldId); }
  const response = await authorizedFetch(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups`,
  );
  const body = await response.json() as { error?: string } & Partial<BackupInventory>;
  if (!response.ok || body.entries === undefined) {
    throw new Error(body.error === "forbidden" ? "Your role cannot read backups." : "The backup inventory is unavailable.");
  }
  return { entries: body.entries, unverified: body.unverified ?? 0, truncated: body.truncated ?? false };
}

export async function requestWorldLifecycle(
  gameId: string,
  worldId: string,
  action: "archive" | "regenerate" | "restore" | "purge",
  backupKey?: string,
  release?: string,
): Promise<{ result: "requested"; operationId: string }> {
  if (demoEnabled) { await demoLatency(); return demo.worldLifecycle(gameId, worldId, action, backupKey, release); }
  const response = await authorizedFetch(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/${action === "regenerate" ? "wipe" : action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "restore" ? { backupKey } : action === "purge" ? { confirmation: worldId } : action === "regenerate" ? { release } : {}),
    },
  );
  const body = await response.json() as { error?: string; result?: "requested"; operationId?: string };
  if (!response.ok || body.result !== "requested" || body.operationId === undefined) {
    const messages: Record<string, string> = {
      forbidden: "Your role cannot manage this world.",
      invalid_purge_confirmation: "Type the exact world ID before permanently deleting it.",
      world_not_archived: "Archive this world before permanently deleting it.",
      invalid_backup_key: "This backup does not belong to the selected world.",
      unknown_materialized_world: "Create this world with its first Start before managing its lifecycle.",
      operation_in_progress: "Another control-plane operation is already running.",
      host_not_unique: "Spawnpoint could not select exactly one compatible host.",
      host_transitioning: "The compute host is already changing state. Try again shortly.",
    };
    throw new Error(messages[body.error ?? ""] ?? `The ${action} request could not be accepted.`);
  }
  return { result: body.result, operationId: body.operationId };
}

export async function requestSessionOperation(gameId: string, worldId: string, action: "start" | "stop"): Promise<{ result: "requested" | "already_stopped"; operationId?: string }> {
  if (demoEnabled) { await demoLatency(); return action === "start" ? demo.startSession(gameId, worldId) : demo.stopSession(gameId, worldId); }
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

export async function loadInvitationRecipients(): Promise<InvitationRecipient[]> {
  if (demoEnabled) { await demoLatency(); return demo.recipients(); }
  const response = await authorizedFetch("/invitations/recipients");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot invite players." : "Players could not be loaded.");
  const body = await response.json() as { recipients: InvitationRecipient[] };
  return body.recipients;
}

export async function loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
  if (demoEnabled) { await demoLatency(); return demo.invitations(gameId, worldId); }
  const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`);
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view invitation history." : "Invitation history could not be loaded.");
  const body = await response.json() as { invitations: InvitationSummary[] };
  return body.invitations;
}

export async function sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
  if (demoEnabled) { await demoLatency(); demo.sendInvitation(gameId, worldId, audience, recipientIdentityIds); return; }
  const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audience, recipientIdentityIds }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    const messages: Record<string, string> = {
      forbidden: "Your role cannot invite players.",
      invalid_recipients: "One or more selected players are no longer available.",
      invitation_publish_failed: "The invitation was saved, but Telegram delivery could not be queued.",
    };
    throw new Error(messages[body.error ?? ""] ?? "The invitation could not be sent.");
  }
}

export async function approveAccessCandidate(telegramId: string, roleId: string): Promise<{ id: string; displayName: string; roleId: string }> {
  if (demoEnabled) { await demoLatency(); return demo.approveCandidate(telegramId, roleId); }
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
  if (demoEnabled) { await demoLatency(); demo.dismissCandidate(telegramId); return; }
  const response = await authorizedFetch(`/access/candidates/${telegramId}/dismiss`, { method: "POST" });
  if (!response.ok) throw new Error("This Telegram account could not be dismissed.");
}

export async function loadAccessIdentities(): Promise<AccessIdentity[]> {
  if (demoEnabled) { await demoLatency(); return demo.identities(); }
  const response = await authorizedFetch("/access/identities");
  if (!response.ok) throw new Error("Users could not be loaded.");
  const body = await response.json() as { identities: AccessIdentity[] };
  return body.identities;
}

export async function loadAccessRoles(): Promise<AccessRole[]> {
  if (demoEnabled) { await demoLatency(); return demo.roles(); }
  const response = await authorizedFetch("/access/roles");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view access roles." : "Roles could not be loaded.");
  const body = await response.json() as { roles: AccessRole[] };
  return body.roles;
}

export async function loadSubscriptions(): Promise<SubscriptionState> {
  if (demoEnabled) { await demoLatency(); return demo.subscriptions(); }
  const response = await authorizedFetch("/me/subscriptions");
  if (!response.ok) throw new Error("Your notification subscriptions could not be loaded.");
  const body = await response.json() as { subscriptions: SubscriptionState };
  return body.subscriptions;
}

export async function updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
  if (demoEnabled) { await demoLatency(); return demo.setSubscriptions(subscriptions); }
  const response = await authorizedFetch("/me/subscriptions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptions }),
  });
  if (!response.ok) throw new Error("Your notification subscriptions could not be saved.");
  const body = await response.json() as { subscriptions: SubscriptionState };
  return body.subscriptions;
}

export async function updateIdentityRole(identityId: string, roleId: string): Promise<void> {
  if (demoEnabled) { await demoLatency(); demo.setIdentityRole(identityId, roleId); return; }
  const response = await authorizedFetch(`/access/identities/${identityId}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? "You cannot change your own Owner role." : "The role could not be changed.");
}
