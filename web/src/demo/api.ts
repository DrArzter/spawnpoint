import type { AuthState, SpawnpointApi } from "../api/contract";
import { demoSession } from "./data";
import { clearDemoFlag, demoLatency } from "./flag";
import * as store from "./store";

// The demo is a transport, not a second panel: it implements the same contract
// the live API does, so every screen, every error path and every navigation is
// the shipped one. Only the data underneath is swapped.
export const demoApi: SpawnpointApi = {
  async restoreSession(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  async exchangeTelegramOidc(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  async revokeSession(): Promise<void> {
    clearDemoFlag();
  },

  async requestAccess(): Promise<void> {
    await demoLatency();
  },

  async loadAccessCandidates() {
    await demoLatency();
    return store.candidates();
  },

  async approveAccessCandidate(telegramId: string, roleId: string) {
    await demoLatency();
    return store.approveCandidate(telegramId, roleId);
  },

  async dismissAccessCandidate(telegramId: string) {
    await demoLatency();
    store.dismissCandidate(telegramId);
  },

  async loadAccessIdentities() {
    await demoLatency();
    return store.identities();
  },

  async loadAccessRoles() {
    await demoLatency();
    return store.roles();
  },

  async updateIdentityRole(identityId: string, roleId: string) {
    await demoLatency();
    store.setIdentityRole(identityId, roleId);
  },

  async loadControlPlane() {
    await demoLatency();
    return store.snapshot();
  },

  subscribeControlPlane(onInvalidated) {
    const timer = window.setInterval(onInvalidated, 1_000);
    return () => window.clearInterval(timer);
  },

  async requestSessionOperation(gameId: string, worldId: string, action) {
    await demoLatency();
    return action === "start" ? store.startSession(gameId, worldId) : store.stopSession(gameId, worldId);
  },

  async requestWorldLifecycle(gameId: string, worldId: string, action, backupKey?: string, release?: string) {
    await demoLatency();
    return store.worldLifecycle(gameId, worldId, action, backupKey, release);
  },

  async requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string) {
    await demoLatency();
    return store.createWorld(gameId, presetId, displayName, release);
  },

  async requestPackDownload(gameId: string, worldId: string) {
    await demoLatency();
    return store.packLink(gameId, worldId);
  },

  async loadBackups(gameId: string, worldId: string) {
    await demoLatency();
    return store.backups(gameId, worldId);
  },

  async loadInvitationRecipients() {
    await demoLatency();
    return store.recipients();
  },

  async loadInvitationHistory(gameId: string, worldId: string) {
    await demoLatency();
    return store.invitations(gameId, worldId);
  },

  async sendInvitation(gameId: string, worldId: string, audience, recipientIdentityIds) {
    await demoLatency();
    store.sendInvitation(gameId, worldId, audience, recipientIdentityIds);
  },

  async loadSubscriptions() {
    await demoLatency();
    return store.subscriptions();
  },

  async updateSubscriptions(subscriptions) {
    await demoLatency();
    return store.setSubscriptions(subscriptions);
  },
};
