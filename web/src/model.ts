export type Page = "dashboard" | "metrics" | "console" | "storage" | "access" | "profile";
export type AccessTab = "users" | "roles" | "notifications";
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export type ReleasePointer = {
  state: "available" | "unconfigured" | "unavailable";
  desiredRelease: string | null;
  activeRelease: string | null;
};
export type World = {
  id: string;
  displayName: string;
  profileId: string;
  sessionControlAvailable: boolean;
  connectivity: "zerotier" | "raw";
  connectionAddress: string | null;
  release: ReleasePointer;
};
export type Lifecycle = {
  schemaVersion: 1;
  serverId: string;
  desiredState: "stopped" | "running";
  observedState: "stopped" | "starting" | "ready" | "stopping" | "unknown";
  activeSessionId: string | null;
  updatedAtEpochSeconds: number;
};
export type Game = { id: string; code: string; displayName: string; lifecycle: Lifecycle | null; worlds: readonly World[] };
export type Host = {
  id: string;
  name: string;
  state: "pending" | "running" | "stopping" | "stopped" | "unknown";
  providerRef?: string;
  instanceType?: string | null;
  availabilityZone?: string | null;
  launchedAt?: string | null;
  publicIp?: string | null;
};
export type Operation = { id: string; type: "start" | "stop" | "promote"; status: "running"; startedAt: string; providerRef?: string };
export type ControlPlaneSnapshot = { observedAt: string; games: readonly Game[]; hosts: readonly Host[]; operations: readonly Operation[] };

export type Role = { id: string; name: string; description: string; permissions: string[]; system?: boolean };
export type LinkKind = "telegram" | "discord" | "minecraft" | "factorio" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
export type Member = { id: string; name: string; roleId: string; links: LinkedAccount[] };
export type OwnerBootstrap =
  | { state: "unclaimed"; telegramId: string }
  | { state: "claimed"; telegramId: string; ownerId: string; claimedAt: string };
