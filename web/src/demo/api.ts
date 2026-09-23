import type { AccessInvitation, AuthState, SpawnpointApi } from "../api/contract";
import type { MetricRange } from "../api/contract";
import { demoSession } from "./data";
import { clearDemoFlag, demoLatency } from "./flag";
import * as store from "./store";

let accessInvitations: AccessInvitation[] = [];

// The demo is a transport, not a second panel: it implements the same contract
// the live API does, so every screen, every error path and every navigation is
// the shipped one. Only the data underneath is swapped.
export const demoApi: SpawnpointApi = {
  async restoreSession(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  async loadLoginOptions() {
    await demoLatency();
    return { providers: ["password" as const, "telegram" as const], selfRegistration: ["password" as const], emailActions: true };
  },

  async exchangeTelegramOidc(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  // The demo answers every way in with its one signed-in owner: the point is
  // to explore the console, not to prove a password.
  async signInWithPassword(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  async registerWithPassword(email: string) {
    await demoLatency();
    return { result: "verification_sent" as const, email };
  },

  async resendEmailVerification(): Promise<void> {
    await demoLatency();
  },

  async verifyEmail(): Promise<AuthState> {
    await demoLatency();
    return { status: "authenticated", session: demoSession };
  },

  async requestPasswordReset(): Promise<void> {
    await demoLatency();
  },

  async resetPassword(): Promise<void> {
    await demoLatency();
  },

  async revokeSession(): Promise<void> {
    clearDemoFlag();
  },

  async loadLinkedAccounts() {
    await demoLatency();
    return {
      passwordManagementAvailable: true,
      linkableProviders: ["telegram"],
      accounts: [
        { provider: "telegram", subject: "1780660807", displayName: "DrArzter", username: "drarzter", email: null, photoUrl: null, verified: true },
        { provider: "password", subject: "demo-password", displayName: "DrArzter", username: null, email: "drarzter@example.dev", photoUrl: null, verified: true },
      ],
    };
  },

  async linkTelegram(): Promise<void> {
    await demoLatency();
  },

  async linkPassword(): Promise<void> {
    await demoLatency();
  },

  async changePassword(): Promise<void> {
    await demoLatency();
  },

  async requestAccess(): Promise<void> {
    await demoLatency();
  },

  async checkAccessInvitation() { await demoLatency(); return { valid: true, email: accessInvitations[0]?.deliveryEmail ?? null }; },
  async redeemAccessInvitation(): Promise<void> { await demoLatency(); },
  async requestAccessInvitationProof(): Promise<void> { await demoLatency(); },
  async loadAccessInvitations() { await demoLatency(); return accessInvitations; },
  async createAccessInvitation(email: string | null) {
    await demoLatency();
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const delivery = email === null ? "not_requested" as const : "sent" as const;
    accessInvitations = [{ id, status: "PENDING", createdAt, expiresAt, usedAt: null, delivery, deliveryEmail: email }, ...accessInvitations];
    return { id, url: `${window.location.origin}/?demo#/join?token=${"d".repeat(43)}`, createdAt, expiresAt, delivery };
  },
  async revokeAccessInvitation(id: string): Promise<void> {
    await demoLatency();
    accessInvitations = accessInvitations.map((invitation) => invitation.id === id ? { ...invitation, status: "REVOKED" } : invitation);
  },

  async loadAccessCandidates() {
    await demoLatency();
    return store.candidates();
  },

  async approveAccessCandidate(platform: string, platformUserId: string, roleId: string) {
    await demoLatency();
    return store.approveCandidate(platform, platformUserId, roleId);
  },

  async dismissAccessCandidate(platform: string, platformUserId: string) {
    await demoLatency();
    store.dismissCandidate(platform, platformUserId);
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

  async requestCreateWorld(gameId: string, presetId: string, displayName: string, release: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    await demoLatency();
    return store.createWorld(gameId, presetId, displayName, release, placement, connectivity, auth);
  },

  async requestUpdateWorldSettings(gameId: string, worldId: string, placement: "configured" | "fleet", connectivity: "zerotier" | "raw" | "route53", auth?: "game" | "external") {
    await demoLatency();
    store.updateWorldSettings(gameId, worldId, placement, connectivity, auth);
  },

  async requestPackDownload(gameId: string, worldId: string) {
    await demoLatency();
    return store.packLink(gameId, worldId);
  },

  async loadBackups(gameId: string, worldId: string) {
    await demoLatency();
    return store.backups(gameId, worldId);
  },

  async loadHostMetrics(instanceId: string, range: MetricRange) {
    await demoLatency();
    return store.hostMetrics(instanceId, range);
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

  async loadAppearance() {
    await demoLatency();
    return store.appearance();
  },

  async updateAppearance(appearance) {
    await demoLatency();
    return store.setAppearance(appearance);
  },
};
