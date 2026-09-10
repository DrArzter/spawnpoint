import type { AccessCandidate, AccessIdentity, AccessRole, ActiveSession, InvitationRecipient, InvitationSummary, SubscriptionState } from "./auth";
import type { ControlPlaneSnapshot } from "./model";

export const previewEnabled = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview");

export const previewSession: ActiveSession = {
  state: "active",
  identity: { id: "identity-owner", displayName: "DrArzter", roleId: "owner", directGrants: [] },
  role: { id: "owner", name: "Owner", permissions: ["status.read", "connection.read", "session.start", "session.stop", "invitation.send", "metrics.read", "console.use", "release.read", "release.promote", "backup.read", "backup.restore", "world.manage", "access.read", "access.manage"] },
  profile: { telegramId: "1780660807", username: "drarzter", photoUrl: null },
  bootstrap: { state: "claimed", ownerId: "identity-owner", telegramId: "1780660807", claimedAt: "2026-08-28T18:24:00.000Z" },
};

export const previewSnapshot: ControlPlaneSnapshot = {
  observedAt: "2026-08-29T18:40:00.000Z",
  games: [
    { id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: { schemaVersion: 1, serverId: "minecraft", desiredState: "running", observedState: "ready", activeSessionId: "session-42", updatedAtEpochSeconds: 1788028800 }, presets: [
      { id: "industrial", displayName: "Industrial", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: "a".repeat(40), profileDigest: "b".repeat(64), buildStatus: "ready", latestRelease: "1.3" },
    ], worlds: [
      { id: "minecraft-rostik-12345678", displayName: "Rostik", profileId: "industrial", sessionControlAvailable: true, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "existing", preset: { id: "industrial", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: "a".repeat(40), profileDigest: "b".repeat(64), buildStatus: "ready", latestRelease: "1.3" }, wipes: [
        { id: `gen-${"1".repeat(32)}`, number: 1, state: "closed", createdAt: "2026-04-01T12:00:00.000Z", closedAt: "2026-08-20T12:00:00.000Z", originRelease: "1.1" },
        { id: `gen-${"2".repeat(32)}`, number: 2, state: "current", createdAt: "2026-08-20T12:00:00.000Z", closedAt: null, originRelease: "1.2" },
      ], connectionAddress: "172.29.23.24:25565", release: { state: "available", generationId: `gen-${"2".repeat(32)}`, activeRelease: "1.2", desiredRelease: "1.2" } },
      { id: "vanilla", displayName: "Vanilla", profileId: "minecraft-vanilla", sessionControlAvailable: true, worldLifecycleAvailable: false, connectivity: "zerotier", materialization: "existing", preset: null, wipes: [], connectionAddress: "172.29.23.24:25565", release: { state: "available", generationId: null, activeRelease: "1.21", desiredRelease: "1.21" } },
    ] },
    { id: "factorio", code: "FA", displayName: "Factorio", lifecycle: { schemaVersion: 1, serverId: "factorio", desiredState: "stopped", observedState: "stopped", activeSessionId: null, updatedAtEpochSeconds: 1788024000 }, presets: [], worlds: [
      { id: "factorio", displayName: "Factorio vanilla", profileId: "factorio-vanilla", sessionControlAvailable: true, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "existing", preset: null, wipes: [], connectionAddress: "172.29.23.24:34197", release: { state: "unconfigured", generationId: null, activeRelease: null, desiredRelease: null } },
      { id: "factorio-archive", displayName: "Archived rail world", profileId: "factorio-rail", sessionControlAvailable: false, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "archived", preset: null, wipes: [], connectionAddress: null, release: { state: "available", generationId: null, activeRelease: "1.0", desiredRelease: "1.0" } },
    ] },
    { id: "zomboid", code: "PZ", displayName: "Project Zomboid", lifecycle: { schemaVersion: 1, serverId: "zomboid", desiredState: "stopped", observedState: "stopped", activeSessionId: null, updatedAtEpochSeconds: 1788024000 }, presets: [], worlds: [
      { id: "zomboid", displayName: "Project Zomboid vanilla", profileId: "zomboid-vanilla", sessionControlAvailable: true, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "existing", preset: null, wipes: [], connectionAddress: "172.29.23.24:16261", release: { state: "unconfigured", generationId: null, activeRelease: null, desiredRelease: null } },
    ] },
  ],
  hosts: [{ id: "host-game", name: "Shared game host", state: "running", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1a", launchedAt: "2026-08-29T18:32:00.000Z", publicIp: "203.0.113.42" }],
  operations: [],
};

export const previewRoles: AccessRole[] = [
  { id: "viewer", name: "Viewer", description: "Can see public server status and request access to play.", permissions: ["status.read"], system: true },
  { id: "player", name: "Player", description: "Can view the server and control a game session.", permissions: ["status.read", "connection.read", "invitation.send", "session.start"], system: true },
  { id: "operator", name: "Operator", description: "Can operate sessions, releases and the console.", permissions: ["status.read", "connection.read", "metrics.read", "console.use", "release.read", "backup.read", "invitation.send", "session.start", "session.stop"], system: true },
  { id: "owner", name: "Owner", description: "Full access to Spawnpoint and its identities.", permissions: previewSession.role?.permissions ?? [], system: true },
];

export const previewIdentities: AccessIdentity[] = [
  { id: "identity-owner", displayName: "DrArzter", roleId: "owner", directGrants: [], links: [{ platform: "telegram", value: "1780660807", verified: true }, { platform: "minecraft", value: "DrArzter", verified: true }, { platform: "zerotier", value: "b9bc15e2cf", verified: true }] },
  { id: "identity-alex", displayName: "Alex", roleId: "player", directGrants: [], links: [{ platform: "telegram", value: "128381920", verified: true }] },
  { id: "identity-mira", displayName: "Mira", roleId: "viewer", directGrants: [], links: [{ platform: "telegram", value: "998120144", verified: true }, { platform: "factorio", value: "Mira", verified: true }] },
];

export const previewCandidates: AccessCandidate[] = [
  { platformUserId: "771246120", displayName: "Nikita", username: "nikita", photoUrl: null, status: "REQUESTED", firstSeenAt: "2026-08-29T17:20:00.000Z", lastSeenAt: "2026-08-29T18:10:00.000Z", requestedAt: "2026-08-29T18:10:00.000Z" },
];

export const previewSubscriptions: SubscriptionState = {
  "minecraft.started": true, "minecraft.stopped": true, "factorio.started": true, "factorio.stopped": false,
  "invitation.broadcast": true, "invitation.direct": true,
};

export const previewRecipients: InvitationRecipient[] = [
  { id: "identity-alex", displayName: "Alex", delivery: "ready" },
  { id: "identity-mira", displayName: "Mira", delivery: "notifications_off" },
];

export const previewInvitations: InvitationSummary[] = [
  { id: "invite-1", audience: "broadcast", status: "DELIVERED", recipientCount: null, targetCount: 2, successCount: 2, failureCount: 0, createdAt: "2026-08-29T17:55:00.000Z" },
];
