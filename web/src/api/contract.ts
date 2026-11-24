import type { LoginProviderId } from "../lib/signin";
import type { ControlPlaneSnapshot, SettingValue, WorldGameSettings } from "../model";
import type { ConsoleEntry } from "../../../contract/console";
import type { HostMetricPoint, HostMetrics, HostMetricSeries, MetricRange } from "../../../contract/metrics";
import type { BackupEntry, BackupInventory } from "../../../contract/backups";
import type { ApiErrorCode } from "../../../contract/errors";
import type { AccessCandidate, AccessIdentity, AccessInvitation, AccessPermission, AccessRole, AccessRoleDirectory, AccountProfile, AppearancePreference, ApprovedIdentity, InvitationRecipient, InvitationSummary, IssuedAccessInvitation, LinkedLoginAccount, LinkedLoginAccounts, LoginOptions, RoleDefinition, SubscriptionState, VisitorSession, ActiveSession as ServedSession } from "../../../contract/access";
import type { HostLogLine, OperationProgress, OperationStep } from "../../../contract/operations";
import type { WorldLogRead } from "../../../contract/world-log";
import type { AssistantAnswer, AssistantConversation, AssistantModel, ConversationSummary } from "../../../contract/assistant";
import type { ConfigFile, ConfigFileContent, ConfigFileList, ConfigFileSource, SavedConfigFile } from "../../../contract/config-files";

// Shapes the API and the panel share live in ../contract (review X2).
export type { ApiErrorCode };
/** What the access, session and profile routes send (contract/access.ts). */
export type { AccessCandidate, AccessIdentity, AccessInvitation, AccessPermission, AccessRole, AccessRoleDirectory, AccountProfile, AppearancePreference, ApprovedIdentity, InvitationRecipient, InvitationSummary, IssuedAccessInvitation, LinkedLoginAccount, LinkedLoginAccounts, LoginOptions, RoleDefinition, SubscriptionState, VisitorSession };
/** A signed-in session; `demo` is set by a transport whose data is not real, so the panel can say so. */
export type ActiveSession = ServedSession & Readonly<{ demo?: boolean }>;
/** A world's recent log and the owner's log assistant (contract/world-log.ts, contract/assistant.ts). */
export type { WorldLogRead, WorldLogStatus } from "../../../contract/world-log";
export type { AssistantAnswer, AssistantConversation, AssistantModel, AssistantProposal, ConversationEntry, ConversationStatus, ConversationSummary } from "../../../contract/assistant";
/** A world's own config files (contract/config-files.ts). */
export type { ConfigFile, ConfigFileContent, ConfigFileList, ConfigFileSource, SavedConfigFile } from "../../../contract/config-files";
export type { BackupEntry, BackupInventory, ConsoleEntry, HostLogLine, HostMetricPoint, HostMetrics, HostMetricSeries, MetricRange, OperationProgress, OperationStep };

export type PromotionResult = { result: "requested"; operationId: string } | { result: "switched" };

export type { LoginProviderId } from "../lib/signin";

/**
 * Why a call did not succeed, which decides what the panel offers next.
 * `forbidden`: the role is short a permission, so there is nothing to retry.
 * `unavailable`: the API did not answer, has no such route or is overloaded
 * (network failure, 501, 503); the screen says so and keeps Retry.
 * `failed`: everything else; Retry stays.
 */
export type ApiFailureKind = "unavailable" | "forbidden" | "failed";

/** The body of an error answer. `error` is the code; other fields (a name, a setting) are its detail. */
export type ApiErrorBody = Readonly<{ error?: unknown } & Record<string, unknown>>;

/** The body's code, read as the contract's (contract/errors.ts): the API refuses with no other. */
export function errorCode(body: ApiErrorBody | null): ApiErrorCode | null {
  return typeof body?.error === "string" ? body.error as ApiErrorCode : null;
}

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  /** The HTTP status; 0 when no answer came. */
  readonly status: number;
  /** The body's `error` field, when the API sent one. */
  readonly code: ApiErrorCode | null;
  readonly detail: ApiErrorBody | null;

  constructor(kind: ApiFailureKind, message: string, source: Readonly<{ status?: number; code?: ApiErrorCode | null; detail?: ApiErrorBody | null }> = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = source.status ?? 0;
    this.code = source.code ?? null;
    this.detail = source.detail ?? null;
  }
}

export function failureKind(error: unknown): ApiFailureKind {
  return error instanceof ApiError ? error.kind : "failed";
}

// The one place a failed answer becomes an ApiError. The API denies by default
// and answers anything it does not route with its own `not_found`; a missing
// resource answers with a code of its own. So a route that was never deployed
// and a world that was never created stay apart.
export async function apiFailure(response: Response, message: string, parsed?: ApiErrorBody | null): Promise<ApiError> {
  const body = parsed !== undefined ? parsed : await response.json().catch(() => null) as ApiErrorBody | null;
  const source = { status: response.status, code: errorCode(body), detail: body };
  const code = source.code;
  if (response.status === 403) return new ApiError("forbidden", message, source);
  if (response.status === 501 || response.status === 503) return new ApiError("unavailable", message, source);
  if (response.status === 404 && code === "not_found") return new ApiError("unavailable", message, source);
  return new ApiError("failed", message, source);
}

/** Why the API refused to delete a person, in words the dialog can show. */
export function identityDeletionRefusal(status: number, error: unknown): string {
  if (status === 409 && error === "self_delete_forbidden") return "You cannot delete yourself.";
  if (status === 409 && error === "last_owner") return "The last Owner cannot be deleted.";
  if (status === 403) return "Your role cannot delete this user.";
  return "This user could not be deleted.";
}

export type SpawnpointSession = ActiveSession | VisitorSession;

/** What a role is created with; `id` is a lower-case slug. */
export type AccessRoleDraft = Readonly<{ name: string; description: string; permissions: string[] }>;



/** Where a release's build fetched a mod. Releases built before it was recorded carry none. */
export type ModSource = "curseforge" | "modrinth" | "github";
/** One server mod of a release, as its manifest records it (ADR-0065). */
export type ReleaseMod = Readonly<{ file: string; sha256: string; bytes: number; source?: ModSource }>;
export type ReleasePackName = "server" | "full";
/** A mod's source as a list filters on it; `unknown` is a mod whose release recorded none. */
export type ModSourceFilter = ModSource | "unknown";
export type ModSortKey = "name" | "source" | "size";
/** What one page of a release's mods is asked for. The server searches, filters, sorts and pages; the panel holds one page. */
export type ReleaseModQuery = Readonly<{
  search: string;
  source: ModSourceFilter | null;
  sort: ModSortKey;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}>;
/**
 * One page of a release's mods, server and players' own set as one list
 * (ADR-0069). `total` counts what the search and filter match, `all` the whole
 * release; `sources` counts the whole release and is empty when it recorded none.
 * `split`: players install a set of their own.
 */
export type ReleaseModPage = Readonly<{
  release: string;
  split: boolean;
  all: number;
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  sources: readonly Readonly<{ source: ModSourceFilter; count: number }>[];
  mods: readonly ReleaseMod[];
}>;
/** One file in a release diff (P3): its mod ids where the release records them, its side when it is an addon (ADR-0077). */
export type DiffMod = Readonly<{ file: string; sha256: string; bytes: number; side: string | null; modIds: readonly string[] | null }>;
export type DiffOverride = Readonly<{ path: string; sha256: string; bytes: number }>;
export type DiffClasses<T> = Readonly<{ added: readonly T[]; removed: readonly T[]; changed: readonly Readonly<{ from: T; to: T }>[]; unchanged: number }>;
export type DiffValue<T> = Readonly<{ from: T | null; to: T | null; changed: boolean }>;
/**
 * What a release changes compared with another of its preset (P3). `plan`: the
 * build's own comparison; `manifests`: diffed from the two releases. `from` is
 * null for a first release.
 */
export type ReleaseDiff = Readonly<{
  release: string;
  from: string | null;
  source: "plan" | "manifests";
  gameVersion: DiffValue<string>;
  loader: DiffValue<Readonly<{ type: string; version: string | null }>>;
  runtimeImage: DiffValue<string>;
  serverMods: DiffClasses<DiffMod>;
  overrides: readonly (Readonly<{ root: string }> & DiffClasses<DiffOverride>)[];
  clientMods: DiffClasses<DiffMod>;
  clientPack: DiffValue<Readonly<{ sha256: string; bytes: number }>>;
}>;
/**
 * A world's whitelist (ADR-0066). Unmanaged: the world's record keeps none, and
 * the names are the running server's own list (none while it is stopped); the
 * first name added makes them the record's. Managed: these names are the whole list.
 */
export type WorldWhitelist = Readonly<{ managed: boolean; names: readonly string[]; updatedAt: string | null; updatedBy: string | null }>;
/** A saved whitelist, and whether a running server was asked to reload it now. */
export type SavedWhitelist = WorldWhitelist & Readonly<{ applied: "reloading" | "next_start" }>;

/** A link the browser opens once; it expires, and is never kept. */
export type FileLink = Readonly<{ url: string; expiresIn: number }>;

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "unconfigured" }
  | { status: "authenticated"; session: SpawnpointSession }
  | { status: "error"; message: string };

export type WorldLifecycleAction = "archive" | "regenerate" | "restore" | "purge";
export type SessionOperation = "start" | "stop";
/** What a stop does with players online. `disconnect` needs session.stop.force. */
export type StopPlayersPolicy = "refuse" | "disconnect";

/** One step of a running workflow: the key is stable, the label is the server's plain words. */

/** One line of the host's own output while a start ran, already filtered and redacted by the API. */



/** One console command and the game's answer, recorded against who ran it (ADR-0063). */

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
  exchangeGoogleOidc(idToken: string): Promise<AuthState>;
  /** Resolves to a session or throws a sentence the form can show beside its fields. */
  signInWithPassword(email: string, password: string): Promise<AuthState>;
  registerWithPassword(email: string, password: string, displayName: string, invitationToken?: string): Promise<{ result: "verification_sent"; email: string }>;
  resendEmailVerification(email: string, invitationToken?: string): Promise<void>;
  verifyEmail(token: string): Promise<AuthState>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  /** Ends the session at its source. Navigation afterwards is the caller's, and is shared. */
  revokeSession(): Promise<void>;

  loadLinkedAccounts(): Promise<LinkedLoginAccounts>;
  linkTelegram(idToken: string): Promise<void>;
  linkGoogle(idToken: string): Promise<void>;
  linkPassword(email: string, password: string, displayName: string): Promise<void>;
  changePassword(email: string, currentPassword: string, password: string): Promise<void>;
  /** `image` is the base64 of a JPEG, PNG or WebP of at most 256 KB. Resolves to the new picture link. */
  uploadAvatar(image: string): Promise<string>;
  removeAvatar(): Promise<void>;

  requestAccess(): Promise<void>;
  checkAccessInvitation(token: string): Promise<{ valid: boolean; email: string | null }>;
  redeemAccessInvitation(token: string, proof?: string): Promise<void>;
  requestAccessInvitationProof(token: string): Promise<void>;
  loadAccessInvitations(): Promise<AccessInvitation[]>;
  createAccessInvitation(email: string | null): Promise<IssuedAccessInvitation>;
  revokeAccessInvitation(id: string): Promise<void>;
  loadAccessCandidates(): Promise<AccessCandidate[]>;
  /** Without a role, the backend gives the default role. */
  approveAccessCandidate(platform: string, platformUserId: string, roleId?: string): Promise<{ id: string; displayName: string; roleId: string }>;
  dismissAccessCandidate(platform: string, platformUserId: string): Promise<void>;
  loadAccessIdentities(): Promise<AccessIdentity[]>;
  loadAccessRoles(): Promise<AccessRoleDirectory>;
  updateIdentityRole(identityId: string, roleId: string): Promise<void>;
  createAccessRole(id: string, draft: AccessRoleDraft): Promise<AccessRole>;
  /** `version` is the one the caller read; a newer one refuses the change (`role_changed`). */
  updateAccessRole(roleId: string, draft: AccessRoleDraft, version: number): Promise<AccessRole>;
  deleteAccessRole(roleId: string, version: number): Promise<void>;
  updateDefaultRole(roleId: string): Promise<string>;
  /** Removes the person and everything that names them; a person already gone succeeds. */
  deleteIdentity(identityId: string): Promise<void>;

  loadControlPlane(): Promise<ControlPlaneSnapshot>;
  /** Subscribe to invalidations only; the caller still reloads its permission-filtered snapshot. */
  subscribeControlPlane(onInvalidated: () => void): () => void;
  requestSessionOperation(gameId: string, worldId: string, action: SessionOperation, players?: StopPlayersPolicy): Promise<{ result: "requested" | "already_stopped"; operationId?: string }>;
  requestWorldLifecycle(gameId: string, worldId: string, action: WorldLifecycleAction, backupKey?: string, release?: string): Promise<{ result: "requested"; operationId: string }>;
  /** Moves a fleet world's open wipe to another release of its preset, keeping its save (ADR-0078). A wipe that never started is switched at once, with no operation. */
  requestPromotion(gameId: string, worldId: string, release: string): Promise<PromotionResult>;
  requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external"): Promise<{ id: string; displayName: string }>;
  requestReleaseBuild(gameId: string, presetId: string, profileDigest: string, retryRelease?: string): Promise<{ release: string; attempt: number }>;
  requestUpdateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external"): Promise<void>;
  requestPackDownload(gameId: string, worldId: string): Promise<{ release: string; url: string }>;
  loadBackups(gameId: string, worldId: string): Promise<BackupInventory>;
  /** A short-lived link to one of the world's archives; the API records who asked. */
  requestBackupDownload(gameId: string, worldId: string, key: string): Promise<FileLink>;
  /** The game settings the world sets (ADR-0064); a running world takes them at its next start. */
  updateGameSettings(gameId: string, worldId: string, values: Readonly<Record<string, SettingValue>>): Promise<WorldGameSettings>;
  loadWhitelist(gameId: string, worldId: string): Promise<WorldWhitelist>;
  /** The whole list; a running world is asked to reload it, any start writes it. */
  updateWhitelist(gameId: string, worldId: string, names: readonly string[]): Promise<SavedWhitelist>;
  /** The files the world may edit, as the next start finds them (ADR-0093). A game with no config rules answers an empty list. */
  loadConfigFiles(gameId: string, worldId: string): Promise<ConfigFileList>;
  loadConfigFile(gameId: string, worldId: string, path: string): Promise<ConfigFileContent>;
  /** `expectedSha256` is the digest the editor loaded, or null for a new file; a changed file is refused. */
  saveConfigFile(gameId: string, worldId: string, path: string, text: string, expectedSha256: string | null): Promise<SavedConfigFile>;
  /** Drops the world's edit so the next start takes the release's file; `expected` is the world's digest. */
  resetConfigFile(gameId: string, worldId: string, path: string, expected: string | null): Promise<void>;
  /** Asks the world's host for its game's newest lines (ADR-0094); read them with loadWorldLog. */
  requestWorldLog(gameId: string, worldId: string): Promise<WorldLogRead>;
  /** One log read, with addresses and player names replaced by tokens; `pending` until the host answers. */
  loadWorldLog(gameId: string, worldId: string, readId: string): Promise<WorldLogRead>;
  /** Asks the model to explain a finished log read; answered later through loadAssistantAnswer. */
  askAssistant(gameId: string, worldId: string, question: Readonly<{ logReadId: string; model: AssistantModel; question: string | null }>): Promise<AssistantAnswer>;
  loadAssistantAnswer(gameId: string, worldId: string, answerId: string): Promise<AssistantAnswer>;
  /** The Owner's conversations with the assistant, newest first (ADR-0096). */
  listConversations(): Promise<readonly ConversationSummary[]>;
  startConversation(model: AssistantModel, message: string): Promise<AssistantConversation>;
  loadConversation(conversationId: string): Promise<AssistantConversation>;
  sendMessage(conversationId: string, model: AssistantModel, message: string): Promise<AssistantConversation>;
  /** Applies a proposal, which runs its change as the Owner, or rejects it. */
  decideProposal(conversationId: string, proposalId: string, decision: "apply" | "reject"): Promise<AssistantConversation>;
  /** A release's server mods, from its manifest. */
  loadReleaseMods(gameId: string, presetId: string, release: string, query: ReleaseModQuery): Promise<ReleaseModPage>;
  /** What a release changes: against `from`, or, with null, against what its build compared it with; null when that build kept no plan. */
  loadReleaseDiff(gameId: string, presetId: string, release: string, from: string | null): Promise<ReleaseDiff | null>;
  /** A short-lived link to one server mod of a release, named by its digest. */
  requestModDownload(gameId: string, presetId: string, release: string, sha256: string): Promise<FileLink>;
  /** The server's set or every mod of a release with side lists (ADR-0069). */
  requestReleasePack(gameId: string, presetId: string, release: string, pack: ReleasePackName): Promise<FileLink>;
  /** The host this world's session runs on, measured; null while the world runs nowhere. */
  loadWorldMetrics(gameId: string, worldId: string, range: MetricRange): Promise<HostMetrics | null>;
  /** One operation of the world; null when the API does not know it. */
  loadOperationProgress(gameId: string, worldId: string, operationId: string): Promise<OperationProgress | null>;
  /** The world's recent console commands, newest first; a pending one is settled on read. */
  loadConsole(gameId: string, worldId: string): Promise<readonly ConsoleEntry[]>;
  runConsoleCommand(gameId: string, worldId: string, command: string): Promise<ConsoleEntry>;

  loadInvitationRecipients(): Promise<InvitationRecipient[]>;
  loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]>;
  sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void>;

  loadSubscriptions(): Promise<SubscriptionState>;
  updateSubscriptions(subscriptions: SubscriptionState): Promise<SubscriptionState>;

  loadAppearance(): Promise<AppearancePreference>;
  updateAppearance(appearance: AppearancePreference): Promise<AppearancePreference>;
}>;
