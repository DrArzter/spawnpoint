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

export async function requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }> {
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

export async function uploadPack(
  file: File,
  details: Readonly<{ release: string; gameId: string; gameVersion: string; loaderVersion: string }>,
  onProgress?: (stage: "uploading" | "publishing") => void,
): Promise<{ operationId: string; release: string }> {
  const created = await authorizedFetch("/releases/uploads", { method: "POST" });
  const target = await created.json() as { error?: string; uploadId?: string; url?: string; contentType?: string };
  if (!created.ok || target.uploadId === undefined || target.url === undefined) {
    throw new Error(target.error === "forbidden" ? "Your role cannot upload packs." : "The upload could not be started.");
  }

  // The bytes go straight to storage with the presigned URL: they never pass
  // through the API, which is what makes a several-hundred-megabyte pack
  // possible at all.
  onProgress?.("uploading");
  const put = await fetch(target.url, {
    method: "PUT",
    body: file,
    headers: { "content-type": target.contentType ?? "application/zip" },
  });
  if (!put.ok) throw new Error("The pack could not be uploaded to storage.");

  onProgress?.("publishing");
  const published = await authorizedFetch(`/releases/uploads/${encodeURIComponent(target.uploadId)}/publish`, {
    method: "POST",
    body: JSON.stringify(details),
  });
  const body = await published.json() as { error?: string; operationId?: string; release?: string };
  if (!published.ok || body.operationId === undefined || body.release === undefined) {
    const messages: Record<string, string> = {
      invalid_release: "A release number looks like 1.2.",
      invalid_game_version: "Give the game version the pack is built for.",
      invalid_loader_version: "Give the loader version the pack is built for.",
      unknown_game: "That game is not in the catalog.",
    };
    throw new Error(messages[body.error ?? ""] ?? "The pack was uploaded but publishing was refused.");
  }
  return { operationId: body.operationId, release: body.release };
}

export type BackupEntry = { key: string; archiveName: string; checksum: string; sizeBytes: number; storedAt: string };
export type BackupInventory = { entries: BackupEntry[]; unverified: number; truncated: boolean };

export async function loadBackups(gameId: string, worldId: string): Promise<BackupInventory> {
  const response = await authorizedFetch(
    `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups`,
  );
  const body = await response.json() as { error?: string } & Partial<BackupInventory>;
  if (!response.ok || body.entries === undefined) {
    throw new Error(body.error === "forbidden" ? "Your role cannot read backups." : "The backup inventory is unavailable.");
  }
  return { entries: body.entries, unverified: body.unverified ?? 0, truncated: body.truncated ?? false };
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

export async function loadInvitationRecipients(): Promise<InvitationRecipient[]> {
  const response = await authorizedFetch("/invitations/recipients");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot invite players." : "Players could not be loaded.");
  const body = await response.json() as { recipients: InvitationRecipient[] };
  return body.recipients;
}

export async function loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
  const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`);
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view invitation history." : "Invitation history could not be loaded.");
  const body = await response.json() as { invitations: InvitationSummary[] };
  return body.invitations;
}

export async function sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
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

export async function loadAccessRoles(): Promise<AccessRole[]> {
  const response = await authorizedFetch("/access/roles");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view access roles." : "Roles could not be loaded.");
  const body = await response.json() as { roles: AccessRole[] };
  return body.roles;
}

export async function loadSubscriptions(): Promise<SubscriptionState> {
  const response = await authorizedFetch("/me/subscriptions");
  if (!response.ok) throw new Error("Your notification subscriptions could not be loaded.");
  const body = await response.json() as { subscriptions: SubscriptionState };
  return body.subscriptions;
}

export async function updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
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
  const response = await authorizedFetch(`/access/identities/${identityId}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? "You cannot change your own Owner role." : "The role could not be changed.");
}
