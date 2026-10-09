export type Page = "worlds" | "releases" | "access" | "profile";
export type AccessTab = "users" | "roles" | "notifications";
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export type ReleasePointer = {
  state: "available" | "unconfigured" | "unavailable";
  generationId: string | null;
  desiredRelease: string | null;
  activeRelease: string | null;
};
export type Preset = {
  id: string;
  displayName: string;
  repository: string;
  commit: string;
  profileDigest: string;
  releases: readonly string[];
  buildStatus: "unbuilt" | "building" | "ready" | "failed";
  latestRelease: string | null;
};
export type Wipe = {
  id: string;
  number: number;
  state: "current" | "closed";
  createdAt: string;
  closedAt: string | null;
  originRelease: string;
};
export type World = {
  id: string;
  displayName: string;
  profileId: string;
  sessionControlAvailable: boolean;
  connectivity: "zerotier" | "raw" | "route53";
  placement?: "configured" | "fleet";
  auth?: "game" | "external" | null;
  materialization: "existing" | "not_created" | "archived";
  worldLifecycleAvailable: boolean;
  wipes: readonly Wipe[];
  preset: null | {
    id: string;
    repository: string;
    commit: string;
    profileDigest: string;
    releases: readonly string[];
    buildStatus: "unbuilt" | "building" | "ready" | "failed";
    latestRelease: string | null;
  };
  connectionAddress: string | null;
  release: ReleasePointer;
  /**
   * This world's session, wherever it lives (ADR-0062): a fleet world's own
   * record, or its game's while that names it. Absent from older responses.
   */
  session?: WorldSession | null;
  /**
   * The game settings this world sets (ADR-0064); null when it has no record
   * to keep them in, as a legacy world does. Absent from older responses.
   */
  gameSettings?: WorldGameSettings | null;
};
export type SettingValue = string | number | boolean;
export type WorldGameSettings = { values: Readonly<Record<string, SettingValue>>; updatedAt: string | null };
/** One setting a world of this game may set, as its game module defines it. */
export type SettingDefinition = { id: string; label: string; hint?: string } & (
  | { type: "choice"; default: string; choices: readonly { value: string; label: string }[] }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "boolean"; default: boolean }
  | { type: "text"; default: string; maxLength: number; pattern: string }
);
export type WorldSession = Omit<Lifecycle, "schemaVersion">;
export type Lifecycle = {
  schemaVersion: 1;
  serverId: string;
  desiredState: "stopped" | "running";
  observedState: "stopped" | "starting" | "ready" | "stopping" | "unknown";
  activeSessionId: string | null;
  activeWorldId: string | null;
  updatedAtEpochSeconds: number;
  /** Present while a watchdog is registered for the session. */
  idle: { playersOnline: number | null; consecutiveEmpty: number; lastObservedAtEpochSeconds: number | null } | null;
};
export type Game = {
  id: string;
  code: string;
  displayName: string;
  lifecycle: Lifecycle | null;
  /** What a world of this game may set (ADR-0064); absent from older responses. */
  settings?: readonly SettingDefinition[];
  /** The game keeps a whitelist a world's record can hold (ADR-0066). */
  whitelist?: boolean;
  presets: readonly Preset[];
  worlds: readonly World[];
};
export type Host = {
  id: string;
  name: string;
  state: "pending" | "running" | "stopping" | "stopped" | "unknown";
  provenance?: "configured" | "launched";
  providerRef?: string;
  instanceType?: string | null;
  availabilityZone?: string | null;
  launchedAt?: string | null;
  publicIp?: string | null;
};
/** `worldId` is the world the workflow's input names; null or absent blocks every world (ADR-0062). */
export type Operation = { id: string; type: "start" | "stop" | "promote" | "world"; status: "running"; startedAt: string; worldId?: string | null; providerRef?: string };
export type ControlPlaneSnapshot = {
  observedAt: string;
  games: readonly Game[];
  hosts: readonly Host[];
  operations: readonly Operation[];
  deployment?: { placement: "single" | "shared" | "fleet"; launchEnabled: boolean; dnsAvailable: boolean };
};

/** A world's console and metrics are its own: several worlds of a game can run at once (ADR-0062). */
export type WorldTab = "details" | "wipes" | "backups" | "releases" | "whitelist" | "console" | "metrics";

export type Role = { id: string; name: string; description: string; permissions: string[]; system?: boolean };
export type LinkKind = "telegram" | "email" | "discord" | "minecraft" | "factorio" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
export type Member = { id: string; name: string; roleId: string; links: LinkedAccount[] };
export type OwnerBootstrap =
  /** The viewer's own Telegram id, when they have one; the configured account is deployment configuration. */
  | { state: "unclaimed"; telegramId: string | null }
  | { state: "claimed"; telegramId: string; ownerId: string; claimedAt: string };
