import type { LoginProviderId } from "../lib/signin";
import type { ControlPlaneSnapshot } from "../model";

export type { LoginProviderId } from "../lib/signin";

/**
 * Why a call did not succeed, which decides what the panel may offer next.
 * `unavailable` means the API has no such route yet — a retry cannot help, and
 * the screen says so calmly. `forbidden` means the role is short a permission.
 * `failed` is everything else and keeps the retry it has always had.
 */
export type ApiFailureKind = "unavailable" | "forbidden" | "failed";

export class ApiError extends Error {
  readonly kind: ApiFailureKind;

  constructor(kind: ApiFailureKind, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

export function failureKind(error: unknown): ApiFailureKind {
  return error instanceof ApiError ? error.kind : "failed";
}

/**
 * The account a session was signed in through. `provider` says which platform
 * vouches for it; the Telegram id stays a named field because the owner
 * bootstrap reads it, and an email account is described by its address.
 */
export type AccountProfile = Readonly<{
  provider: string;
  platformUserId: string;
  telegramId: string | null;
  username: string | null;
  email: string | null;
  photoUrl: string | null;
}>;

export type ActiveSession = Readonly<{
  state: "active";
  /** Set by a transport whose data is not real, so the panel can say so without asking which mode it is in. */
  demo?: boolean;
  identity: { id: string; displayName: string; roleId: string; directGrants: string[] };
  /** What this deployment routes. A screen whose capability is absent is not offered at all. */
  capabilities: readonly string[];
  role: { id: string; name: string; permissions: string[] } | null;
  profile: AccountProfile;
  bootstrap: { state: "unclaimed" } | { state: "claimed"; ownerId: string; telegramId: string; claimedAt: string };
}>;

export type VisitorSession = Readonly<{
  state: "visitor";
  candidate: AccountProfile & {
    displayName: string;
    status: "OBSERVED" | "REQUESTED" | "DISMISSED";
  };
}>;

// The API denies by default and answers anything it does not route with its own
// `not_found`; a missing resource answers with a code of its own. So a route
// that was never deployed and a world that was never created stay apart, and
// only the first is something a retry cannot fix.
export async function apiFailure(response: Response, message: string, parsed?: Readonly<{ error?: unknown }> | null): Promise<ApiError> {
  if (response.status === 403) return new ApiError("forbidden", message);
  if (response.status === 501) return new ApiError("unavailable", message);
  if (response.status === 404) {
    const body = parsed ?? await response.json().catch(() => null) as Readonly<{ error?: unknown }> | null;
    if (body?.error === "not_found") return new ApiError("unavailable", message);
  }
  return new ApiError("failed", message);
}

export type SpawnpointSession = ActiveSession | VisitorSession;

export type AccessCandidate = Readonly<{
  platform: string;
  platformUserId: string;
  displayName: string;
  username: string | null;
  email: string | null;
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
  /** `handle` is the account's own name where it has one: a Telegram username, an email address. */
  links: ReadonlyArray<{ platform: string; value: string; handle: string | null; verified: boolean }>;
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

export type BackupEntry = {
  key: string;
  archiveName: string;
  checksum: string;
  generationId: string | null;
  sizeBytes: number;
  storedAt: string;
};

export type BackupInventory = { entries: BackupEntry[]; unverified: number; truncated: boolean };

export type MetricRange = "6h" | "24h" | "7d";
export type HostMetricPoint = Readonly<{ at: string; value: number | null }>;
export type HostMetricSeries = Readonly<{ id: string; label: string; unit: string; points: readonly HostMetricPoint[] }>;
export type HostMetrics = Readonly<{ range: MetricRange; startedAt: string; endedAt: string; periodSeconds: number; series: readonly HostMetricSeries[] }>;

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unconfigured" }
  | { status: "authenticated"; session: SpawnpointSession }
  | { status: "error"; message: string };

export type WorldLifecycleAction = "archive" | "regenerate" | "restore" | "purge";
export type SessionOperation = "start" | "stop";
export type LoginOptions = Readonly<{
  providers: readonly LoginProviderId[];
  /** Providers through which an anonymous visitor may create a credential. */
  selfRegistration: readonly LoginProviderId[];
}>;

/**
 * Everything the panel asks of a backend. The live transport and the demo both
 * implement it, so a screen cannot tell them apart and the demo cannot quietly
 * skip a call: leaving one out is a type error.
 */
export type SpawnpointApi = Readonly<{
  restoreSession(): Promise<AuthState>;
  /** Which ways in the deployment offers, and which accept anonymous registration. */
  loadLoginOptions(): Promise<LoginOptions>;
  exchangeTelegramOidc(idToken: string): Promise<AuthState>;
  /** Both resolve to a session or throw a sentence the form can show beside its fields. */
  signInWithPassword(email: string, password: string): Promise<AuthState>;
  registerWithPassword(email: string, password: string, displayName: string): Promise<AuthState>;
  /** Ends the session at its source. Navigation afterwards is the caller's, and is shared. */
  revokeSession(): Promise<void>;

  requestAccess(): Promise<void>;
  loadAccessCandidates(): Promise<AccessCandidate[]>;
  approveAccessCandidate(platform: string, platformUserId: string, roleId: string): Promise<{ id: string; displayName: string; roleId: string }>;
  dismissAccessCandidate(platform: string, platformUserId: string): Promise<void>;
  loadAccessIdentities(): Promise<AccessIdentity[]>;
  loadAccessRoles(): Promise<AccessRole[]>;
  updateIdentityRole(identityId: string, roleId: string): Promise<void>;

  loadControlPlane(): Promise<ControlPlaneSnapshot>;
  /** Subscribe to invalidations only; the caller still reloads its permission-filtered snapshot. */
  subscribeControlPlane(onInvalidated: () => void): () => void;
  requestSessionOperation(gameId: string, worldId: string, action: SessionOperation): Promise<{ result: "requested" | "already_stopped"; operationId?: string }>;
  requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string): Promise<{ result: "requested"; operationId: string }>;
  requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string): Promise<{ id: string; displayName: string }>;
  requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }>;
  loadBackups(gameId: string, worldId: string): Promise<BackupInventory>;
  loadHostMetrics(instanceId: string, range: MetricRange): Promise<HostMetrics>;

  loadInvitationRecipients(): Promise<InvitationRecipient[]>;
  loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]>;
  sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void>;

  loadSubscriptions(): Promise<SubscriptionState>;
  updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState>;
}>;
