import type { ControlPlaneSnapshot } from "../model";

export type ActiveSession = Readonly<{
  state: "active";
  /** Set by a transport whose data is not real, so the panel can say so without asking which mode it is in. */
  demo?: boolean;
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

export type BackupEntry = {
  key: string;
  archiveName: string;
  checksum: string;
  generationId: string | null;
  sizeBytes: number;
  storedAt: string;
};

export type BackupInventory = { entries: BackupEntry[]; unverified: number; truncated: boolean };

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unconfigured" }
  | { status: "authenticated"; session: SpawnpointSession }
  | { status: "error"; message: string };

export type WorldLifecycleAction = "archive" | "regenerate" | "restore" | "purge";
export type SessionOperation = "start" | "stop";

/**
 * Everything the panel asks of a backend. The live transport and the demo both
 * implement it, so a screen cannot tell them apart and the demo cannot quietly
 * skip a call: leaving one out is a type error.
 */
export type SpawnpointApi = Readonly<{
  restoreSession(): Promise<AuthState>;
  exchangeTelegramOidc(idToken: string): Promise<AuthState>;
  /** Ends the session at its source. Navigation afterwards is the caller's, and is shared. */
  revokeSession(): Promise<void>;

  requestAccess(): Promise<void>;
  loadAccessCandidates(): Promise<AccessCandidate[]>;
  approveAccessCandidate(telegramId: string, roleId: string): Promise<{ id: string; displayName: string; roleId: string }>;
  dismissAccessCandidate(telegramId: string): Promise<void>;
  loadAccessIdentities(): Promise<AccessIdentity[]>;
  loadAccessRoles(): Promise<AccessRole[]>;
  updateIdentityRole(identityId: string, roleId: string): Promise<void>;

  loadControlPlane(): Promise<ControlPlaneSnapshot>;
  requestSessionOperation(gameId: string, worldId: string, action: SessionOperation): Promise<{ result: "requested" | "already_stopped"; operationId?: string }>;
  requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string): Promise<{ result: "requested"; operationId: string }>;
  requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string): Promise<{ id: string; displayName: string }>;
  requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }>;
  loadBackups(gameId: string, worldId: string): Promise<BackupInventory>;

  loadInvitationRecipients(): Promise<InvitationRecipient[]>;
  loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]>;
  sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void>;

  loadSubscriptions(): Promise<SubscriptionState>;
  updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState>;
}>;
