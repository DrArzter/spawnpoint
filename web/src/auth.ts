import { demoApi, demoEnabled } from "./demo";
import type { AppearancePreference, SpawnpointApi, SubscriptionState } from "./api/contract";
import { liveApi, liveAuthConfigured } from "./api/live";

export type {
  AccessCandidate, AccessIdentity, AccessRole, AccountProfile, ActiveSession, AppearancePreference, AuthState, BackupEntry,
  BackupInventory, HostMetrics, HostMetricSeries, InvitationRecipient, InvitationSummary, LinkedLoginAccount, LinkedLoginAccounts, LoginOptions, LoginProviderId,
  MetricRange, SessionOperation,
  SpawnpointApi, SpawnpointSession, SubscriptionState, VisitorSession, WorldLifecycleAction,
} from "./api/contract";
import type { MetricRange } from "./api/contract";
export { telegramOidcClientId } from "./api/live";

// One switch, in one place. Everything below is the shipped panel calling the
// shipped contract; the demo differs in what answers, never in what is asked
// or in what happens next.
const api: SpawnpointApi = demoEnabled ? demoApi : liveApi;

export function authConfigured(): boolean {
  return liveAuthConfigured();
}

export const restoreAuth = (): ReturnType<SpawnpointApi["restoreSession"]> => api.restoreSession();
export const loadLoginOptions = () => api.loadLoginOptions();
export const exchangeTelegramOidc = (idToken: string) => api.exchangeTelegramOidc(idToken);
export const signInWithPassword = (email: string, password: string) => api.signInWithPassword(email, password);
export const registerWithPassword = (email: string, password: string, displayName: string) => api.registerWithPassword(email, password, displayName);
export const resendEmailVerification = (email: string) => api.resendEmailVerification(email);
export const verifyEmail = (token: string) => api.verifyEmail(token);
export const requestPasswordReset = (email: string) => api.requestPasswordReset(email);
export const resetPassword = (token: string, password: string) => api.resetPassword(token, password);
export const loadLinkedAccounts = () => api.loadLinkedAccounts();
export const linkTelegram = (idToken: string) => api.linkTelegram(idToken);
export const linkPassword = (email: string, password: string, displayName: string) => api.linkPassword(email, password, displayName);
export const changePassword = (email: string, currentPassword: string, password: string) => api.changePassword(email, currentPassword, password);

export const requestAccess = () => api.requestAccess();
export const loadAccessCandidates = () => api.loadAccessCandidates();
export const approveAccessCandidate = (platform: string, platformUserId: string, roleId: string) => api.approveAccessCandidate(platform, platformUserId, roleId);
export const dismissAccessCandidate = (platform: string, platformUserId: string) => api.dismissAccessCandidate(platform, platformUserId);
export const loadAccessIdentities = () => api.loadAccessIdentities();
export const loadAccessRoles = () => api.loadAccessRoles();
export const updateIdentityRole = (identityId: string, roleId: string) => api.updateIdentityRole(identityId, roleId);

export const loadControlPlane = () => api.loadControlPlane();
export const subscribeControlPlane = (onInvalidated: () => void) => api.subscribeControlPlane(onInvalidated);
export const requestSessionOperation = (gameId: string, worldId: string, action: "start" | "stop") => api.requestSessionOperation(gameId, worldId, action);
export const requestWorldLifecycle = (gameId: string, worldId: string, action: "archive" | "regenerate" | "restore" | "purge", backupKey?: string, release?: string) => api.requestWorldLifecycle(gameId, worldId, action, backupKey, release);
export const requestCreateWorld = (gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") => api.requestCreateWorld(gameId, presetId, displayName, release, placement, connectivity, auth);
export const requestUpdateWorldSettings = (gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") => api.requestUpdateWorldSettings(gameId, worldId, placement, connectivity, auth);
export const requestPackDownload = (gameId: string, worldId: string) => api.requestPackDownload(gameId, worldId);
export const loadBackups = (gameId: string, worldId: string) => api.loadBackups(gameId, worldId);
export const loadHostMetrics = (instanceId: string, range: MetricRange) => api.loadHostMetrics(instanceId, range);

export const loadInvitationRecipients = () => api.loadInvitationRecipients();
export const loadInvitationHistory = (gameId: string, worldId: string) => api.loadInvitationHistory(gameId, worldId);
export const sendInvitation = (gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]) => api.sendInvitation(gameId, worldId, audience, recipientIdentityIds);

export const loadSubscriptions = () => api.loadSubscriptions();
export const updateSubscriptions = (subscriptions: SubscriptionState) => api.updateSubscriptions(subscriptions);

export const loadAppearance = () => api.loadAppearance();
export const updateAppearance = (appearance: AppearancePreference) => api.updateAppearance(appearance);

// The front door has its own address so a sign-out lands there even if the
// session outlives the request that was meant to end it.
const FRONT_DOOR = "#/welcome";

function returnToFrontDoor(): void {
  // Assigning a hash-only difference never reloads the document, which used to
  // leave a signed-out tab holding the session's data and its React state.
  // Rewriting the address and reloading is the one path that always ends clean.
  window.history.replaceState(null, "", `${window.location.pathname}${FRONT_DOOR}`);
  window.location.reload();
}

export async function endSession(): Promise<void> {
  try {
    await api.revokeSession();
  } finally {
    returnToFrontDoor();
  }
}
