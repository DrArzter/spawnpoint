import type { AccessCandidate, AccessIdentity, AccessRole, ActiveSession, AppearancePreference, BackupEntry, InvitationSummary, SubscriptionState } from "../auth";
import type { ControlPlaneSnapshot } from "../model";
import { DEFAULT_ACCENT } from "../styles/accent";

// The demo mutates its own control plane, so every record it holds is mutable
// while the app keeps reading the real read-only domain types.
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object | null ? (T[K] extends null ? T[K] : Mutable<T[K]>) : T[K];
};

export type DemoState = {
  snapshot: Mutable<ControlPlaneSnapshot>;
  roles: AccessRole[];
  identities: Mutable<AccessIdentity>[];
  candidates: Mutable<AccessCandidate>[];
  delivery: Record<string, "ready" | "notifications_off" | "bot_unavailable">;
  subscriptions: SubscriptionState;
  appearance: AppearancePreference;
  invitations: Record<string, InvitationSummary[]>;
  backups: Record<string, BackupEntry[]>;
  /** Effects that land when their time passes; read calls settle them. */
  scheduled: { operationId: string; at: number; apply: (state: DemoState) => void }[];
  counter: number;
};

export const demoSession: ActiveSession = {
  state: "active",
  demo: true,
  identity: { id: "identity-owner", displayName: "DrArzter", roleId: "owner", directGrants: [] },
  // The in-memory transport answers everything, so it can do everything. This
  // is what keeps a screen fully explorable before its route is written.
  capabilities: ["releaseManifest", "invitations", "clientPacks", "backups", "worldLifecycle", "accessManagement"],
  role: { id: "owner", name: "Owner", permissions: ["status.read", "connection.read", "session.start", "session.stop", "invitation.send", "metrics.read", "console.use", "release.read", "release.promote", "backup.read", "backup.restore", "world.manage", "access.read", "access.manage"] },
  profile: { telegramId: "1780660807", username: "drarzter", photoUrl: null },
  bootstrap: { state: "claimed", ownerId: "identity-owner", telegramId: "1780660807", claimedAt: "2026-08-28T18:24:00.000Z" },
};

const OWNER_PERMISSIONS = demoSession.role?.permissions ?? [];

export function initialState(): DemoState {
  return {
    snapshot: {
      observedAt: new Date().toISOString(),
      operations: [],
      hosts: [{ id: "host-game", name: "Shared game host", state: "running", instanceType: "m7i-flex.large", availabilityZone: "eu-central-1a", launchedAt: "2026-09-14T18:32:00.000Z", publicIp: "203.0.113.42" }],
      games: [
        {
          id: "minecraft",
          code: "MC",
          displayName: "Minecraft",
          lifecycle: { schemaVersion: 1, serverId: "minecraft", desiredState: "running", observedState: "ready", activeSessionId: "session-42", activeWorldId: "minecraft-rostik-12345678", updatedAtEpochSeconds: Math.floor(Date.now() / 1000), idle: { playersOnline: 3, consecutiveEmpty: 0, lastObservedAtEpochSeconds: Math.floor(Date.now() / 1000) - 45 } },
          presets: [
            { id: "industrial", displayName: "Industrial", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: "7f3c19ab4d0e52b8916cfa07d5e483126bd90af5", profileDigest: "41d9a8e0c73b5f26184ad0e9cb7f3520a6e81d4c95f27b03ea6d183c7b40f9e2", releases: ["1.1", "1.2", "1.3"], buildStatus: "ready", latestRelease: "1.3" },
            { id: "skyblock", displayName: "Skyblock", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: "2b8e04f7a1c63d95e0847bf21a5d3906c7e4128b", profileDigest: "9c1e57a30b8d426fa9e271c04b5f83da6017e94b2c85fd30a7b16e2f48c0d95a", releases: [], buildStatus: "building", latestRelease: null },
          ],
          worlds: [
            {
              id: "minecraft-rostik-12345678",
              displayName: "Rostik",
              profileId: "industrial",
              sessionControlAvailable: true,
              worldLifecycleAvailable: true,
              connectivity: "zerotier",
              materialization: "existing",
              preset: { id: "industrial", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: "7f3c19ab4d0e52b8916cfa07d5e483126bd90af5", profileDigest: "41d9a8e0c73b5f26184ad0e9cb7f3520a6e81d4c95f27b03ea6d183c7b40f9e2", releases: ["1.1", "1.2", "1.3"], buildStatus: "ready", latestRelease: "1.3" },
              wipes: [
                { id: "gen-4a1f7c02e89b5d3641ca0e7852bd93f0", number: 1, state: "closed", createdAt: "2026-04-01T12:00:00.000Z", closedAt: "2026-08-20T12:00:00.000Z", originRelease: "1.1" },
                { id: "gen-c73b18ae5f0492d6817be30a4c95f2d1", number: 2, state: "current", createdAt: "2026-08-20T12:00:00.000Z", closedAt: null, originRelease: "1.2" },
              ],
              connectionAddress: "172.29.23.24:25565",
              release: { state: "available", generationId: "gen-c73b18ae5f0492d6817be30a4c95f2d1", activeRelease: "1.2", desiredRelease: "1.2" },
            },
            {
              id: "vanilla",
              displayName: "Vanilla",
              profileId: "minecraft-vanilla",
              sessionControlAvailable: true,
              worldLifecycleAvailable: false,
              connectivity: "zerotier",
              materialization: "existing",
              preset: null,
              wipes: [],
              connectionAddress: "172.29.23.24:25565",
              release: { state: "available", generationId: null, activeRelease: "1.21", desiredRelease: "1.21" },
            },
          ],
        },
        {
          id: "factorio",
          code: "FA",
          displayName: "Factorio",
          lifecycle: { schemaVersion: 1, serverId: "factorio", desiredState: "stopped", observedState: "stopped", activeSessionId: null, activeWorldId: null, updatedAtEpochSeconds: Math.floor(Date.now() / 1000), idle: null },
          presets: [],
          worlds: [
            { id: "factorio", displayName: "Factorio vanilla", profileId: "factorio-vanilla", sessionControlAvailable: true, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "existing", preset: null, wipes: [], connectionAddress: "172.29.23.24:34197", release: { state: "unconfigured", generationId: null, activeRelease: null, desiredRelease: null } },
            { id: "factorio-archive", displayName: "Archived rail world", profileId: "factorio-rail", sessionControlAvailable: false, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "archived", preset: null, wipes: [], connectionAddress: null, release: { state: "available", generationId: null, activeRelease: "1.0", desiredRelease: "1.0" } },
          ],
        },
        {
          id: "zomboid",
          code: "PZ",
          displayName: "Project Zomboid",
          lifecycle: { schemaVersion: 1, serverId: "zomboid", desiredState: "stopped", observedState: "stopped", activeSessionId: null, activeWorldId: null, updatedAtEpochSeconds: Math.floor(Date.now() / 1000), idle: null },
          presets: [],
          worlds: [
            { id: "zomboid", displayName: "Project Zomboid vanilla", profileId: "zomboid-vanilla", sessionControlAvailable: true, worldLifecycleAvailable: true, connectivity: "zerotier", materialization: "not_created", preset: null, wipes: [], connectionAddress: "172.29.23.24:16261", release: { state: "unconfigured", generationId: null, activeRelease: null, desiredRelease: null } },
          ],
        },
      ],
    },
    roles: [
      { id: "viewer", name: "Viewer", description: "Can see public server status and request access to play.", permissions: ["status.read"], system: true },
      { id: "player", name: "Player", description: "Can view the server and control a game session.", permissions: ["status.read", "connection.read", "invitation.send", "session.start"], system: true },
      { id: "operator", name: "Operator", description: "Can operate sessions, releases and the console.", permissions: ["status.read", "connection.read", "metrics.read", "console.use", "release.read", "backup.read", "invitation.send", "session.start", "session.stop"], system: true },
      { id: "owner", name: "Owner", description: "Full access to Spawnpoint and its identities.", permissions: [...OWNER_PERMISSIONS], system: true },
    ],
    identities: [
      { id: "identity-owner", displayName: "DrArzter", roleId: "owner", directGrants: [], links: [{ platform: "telegram", value: "1780660807", verified: true }, { platform: "minecraft", value: "DrArzter", verified: true }, { platform: "zerotier", value: "b9bc15e2cf", verified: true }] },
      { id: "identity-alex", displayName: "Alex", roleId: "player", directGrants: [], links: [{ platform: "telegram", value: "128381920", verified: true }] },
      { id: "identity-mira", displayName: "Mira", roleId: "viewer", directGrants: [], links: [{ platform: "telegram", value: "998120144", verified: true }, { platform: "factorio", value: "Mira", verified: true }] },
    ],
    candidates: [
      { platformUserId: "771246120", displayName: "Nikita", username: "nikita", photoUrl: null, status: "REQUESTED", firstSeenAt: "2026-09-14T17:20:00.000Z", lastSeenAt: "2026-09-14T18:10:00.000Z", requestedAt: "2026-09-14T18:10:00.000Z" },
      { platformUserId: "664120993", displayName: "Sasha", username: null, photoUrl: null, status: "OBSERVED", firstSeenAt: "2026-09-13T09:02:00.000Z", lastSeenAt: "2026-09-14T11:41:00.000Z", requestedAt: null },
    ],
    delivery: { "identity-alex": "ready", "identity-mira": "notifications_off" },
    subscriptions: {
      "minecraft.started": true, "minecraft.stopped": true, "factorio.started": true, "factorio.stopped": false,
      "invitation.broadcast": true, "invitation.direct": true,
    },
    appearance: { theme: "system", accent: DEFAULT_ACCENT },
    invitations: {
      "minecraft/minecraft-rostik-12345678": [
        { id: "invite-1", audience: "broadcast", status: "DELIVERED", recipientCount: null, targetCount: 2, successCount: 2, failureCount: 0, createdAt: "2026-09-14T17:55:00.000Z" },
      ],
    },
    backups: {
      "minecraft/minecraft-rostik-12345678": [
        { key: "worlds/minecraft-rostik-12345678/archives/20260914T173200Z", archiveName: "minecraft-rostik-12345678-20260914T173200Z.tar.zst", checksum: "8b4e3a7d24c09ea61de95cdb613cfb9bea802cff4cb67f2ed0a910832d96f231", generationId: "gen-c73b18ae5f0492d6817be30a4c95f2d1", sizeBytes: 184549376, storedAt: "2026-09-14T17:32:00.000Z" },
        { key: "worlds/minecraft-rostik-12345678/archives/20260912T221500Z", archiveName: "minecraft-rostik-12345678-20260912T221500Z.tar.zst", checksum: "294c47d3cbd1d52ed7117338b0e44a28d5ae53b9b0ad9f563172c8b4fbfd19cc", generationId: "gen-4a1f7c02e89b5d3641ca0e7852bd93f0", sizeBytes: 178257920, storedAt: "2026-09-12T22:15:00.000Z" },
      ],
      "factorio/factorio": [
        { key: "worlds/factorio/archives/20260908T201100Z", archiveName: "factorio-20260908T201100Z.tar.zst", checksum: "5f2d0c7b9a1e4438ac6f05d2e7b3418c9d6a2f7e0b5c84913ad2e6f70b9c3d55", generationId: null, sizeBytes: 42991616, storedAt: "2026-09-08T20:11:00.000Z" },
      ],
    },
    scheduled: [],
    counter: 0,
  };
}
