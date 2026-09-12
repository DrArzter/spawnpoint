import type { ControlPlaneSnapshot } from "./model";
import { previewCandidates, previewEnabled, previewIdentities, previewInvitations, previewRecipients, previewRoles, previewSession, previewSnapshot, previewSubscriptions } from "./preview";

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
  if (previewEnabled) return { status: "authenticated", session: previewSession };
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
  if (previewEnabled) return;
  const response = await authorizedFetch("/access/request", { method: "POST" });
  if (!response.ok) throw new Error("The access request could not be sent.");
}

export async function loadAccessCandidates(): Promise<AccessCandidate[]> {
  if (previewEnabled) return previewCandidates;
  const response = await authorizedFetch("/access/candidates");
  if (!response.ok) throw new Error("Access requests could not be loaded.");
  const body = await response.json() as { candidates: AccessCandidate[] };
  return body.candidates;
}

export async function loadControlPlane(): Promise<ControlPlaneSnapshot> {
  if (previewEnabled) return previewSnapshot;
  const response = await authorizedFetch("/control-plane");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view server status." : "The control-plane state could not be loaded.");
  return response.json() as Promise<ControlPlaneSnapshot>;
}

export async function requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }> {
  if (previewEnabled) return { release: "1.2", url: "about:blank#spawnpoint-preview-pack" };
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
  if (previewEnabled) return { id: `${gameId}-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-preview`, displayName };
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
  const previewGenerationIds = gameId === "minecraft" && worldId === "minecraft-rostik-12345678"
    ? [`gen-${"2".repeat(32)}`, `gen-${"1".repeat(32)}`]
    : [`generation-${worldId}-01`, `generation-${worldId}-01`];
  if (previewEnabled) return {
    entries: [
      { key: `worlds/${worldId}/archives/preview-a`, archiveName: `${worldId}-20260829T173200Z.tar.zst`, checksum: "8b4e3a7d24c09ea61de95cdb613cfb9bea802cff4cb67f2ed0a910832d96f231", generationId: previewGenerationIds[0]!, sizeBytes: 184549376, storedAt: "2026-08-29T17:32:00.000Z" },
      { key: `worlds/${worldId}/archives/preview-b`, archiveName: `${worldId}-20260827T221500Z.tar.zst`, checksum: "294c47d3cbd1d52ed7117338b0e44a28d5ae53b9b0ad9f563172c8b4fbfd19cc", generationId: previewGenerationIds[1]!, sizeBytes: 178257920, storedAt: "2026-08-27T22:15:00.000Z" },
    ],
    unverified: 1,
    truncated: false,
  };
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
  if (previewEnabled) return { result: "requested", operationId: `preview-world-${action}` };
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
  if (previewEnabled) return { result: "requested", operationId: `preview-${gameId}-${worldId}-${action}` };
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
  if (previewEnabled) return previewRecipients;
  const response = await authorizedFetch("/invitations/recipients");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot invite players." : "Players could not be loaded.");
  const body = await response.json() as { recipients: InvitationRecipient[] };
  return body.recipients;
}

export async function loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
  if (previewEnabled) return previewInvitations;
  const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`);
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view invitation history." : "Invitation history could not be loaded.");
  const body = await response.json() as { invitations: InvitationSummary[] };
  return body.invitations;
}

export async function sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
  if (previewEnabled) return;
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
  if (previewEnabled) return { id: `identity-${telegramId}`, displayName: previewCandidates.find((candidate) => candidate.platformUserId === telegramId)?.displayName ?? "Preview user", roleId };
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
  if (previewEnabled) return;
  const response = await authorizedFetch(`/access/candidates/${telegramId}/dismiss`, { method: "POST" });
  if (!response.ok) throw new Error("This Telegram account could not be dismissed.");
}

export async function loadAccessIdentities(): Promise<AccessIdentity[]> {
  if (previewEnabled) return previewIdentities;
  const response = await authorizedFetch("/access/identities");
  if (!response.ok) throw new Error("Users could not be loaded.");
  const body = await response.json() as { identities: AccessIdentity[] };
  return body.identities;
}

export async function loadAccessRoles(): Promise<AccessRole[]> {
  if (previewEnabled) return previewRoles;
  const response = await authorizedFetch("/access/roles");
  if (!response.ok) throw new Error(response.status === 403 ? "Your role cannot view access roles." : "Roles could not be loaded.");
  const body = await response.json() as { roles: AccessRole[] };
  return body.roles;
}

export async function loadSubscriptions(): Promise<SubscriptionState> {
  if (previewEnabled) return previewSubscriptions;
  const response = await authorizedFetch("/me/subscriptions");
  if (!response.ok) throw new Error("Your notification subscriptions could not be loaded.");
  const body = await response.json() as { subscriptions: SubscriptionState };
  return body.subscriptions;
}

export async function updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState> {
  if (previewEnabled) return subscriptions;
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
  if (previewEnabled) return;
  const response = await authorizedFetch(`/access/identities/${identityId}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roleId }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? "You cannot change your own Owner role." : "The role could not be changed.");
}
