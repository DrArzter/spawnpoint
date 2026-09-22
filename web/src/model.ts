export type Page = "worlds" | "metrics" | "console" | "releases" | "access" | "profile";
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
};
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
export type Game = { id: string; code: string; displayName: string; lifecycle: Lifecycle | null; presets: readonly Preset[]; worlds: readonly World[] };
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
export type Operation = { id: string; type: "start" | "stop" | "promote" | "world"; status: "running"; startedAt: string; providerRef?: string };
export type ControlPlaneSnapshot = {
  observedAt: string;
  games: readonly Game[];
  hosts: readonly Host[];
  operations: readonly Operation[];
  deployment?: { placement: "single" | "shared" | "fleet"; launchEnabled: boolean; dnsAvailable: boolean };
};

export type WorldTab = "details" | "wipes" | "backups" | "releases";

export type Role = { id: string; name: string; description: string; permissions: string[]; system?: boolean };
export type LinkKind = "telegram" | "email" | "discord" | "minecraft" | "factorio" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
export type Member = { id: string; name: string; roleId: string; links: LinkedAccount[] };
export type OwnerBootstrap =
  /** The viewer's own Telegram id, when they have one; the configured account is deployment configuration. */
  | { state: "unclaimed"; telegramId: string | null }
  | { state: "claimed"; telegramId: string; ownerId: string; claimedAt: string };
