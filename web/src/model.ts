export type Page = "dashboard" | "metrics" | "console" | "storage" | "access" | "profile";
export type AccessTab = "users" | "roles" | "notifications";
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export type ReleasePointer = {
  state: "available" | "unconfigured" | "unavailable";
  desiredRelease: string | null;
  activeRelease: string | null;
};
export type World = { id: string; displayName: string; profileId: string; sessionControlAvailable: boolean; release: ReleasePointer };
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
};
export type Operation = { id: string; type: "start" | "stop" | "promote"; status: "running"; startedAt: string; providerRef?: string };
export type ControlPlaneSnapshot = { observedAt: string; games: readonly Game[]; hosts: readonly Host[]; operations: readonly Operation[] };

export type Permission = {
  id: string;
  group: "Server" | "Console" | "Storage" | "Observability" | "Access";
  label: string;
};

export type Role = { id: string; name: string; description: string; permissions: string[]; system?: boolean };
export type LinkKind = "telegram" | "discord" | "minecraft" | "factorio" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
export type Member = { id: string; name: string; roleId: string; links: LinkedAccount[] };
export type OwnerBootstrap =
  | { state: "unclaimed"; telegramId: string }
  | { state: "claimed"; telegramId: string; ownerId: string; claimedAt: string };

export const permissions: readonly Permission[] = [
  { id: "status.read", group: "Server", label: "View coarse server state" },
  { id: "connection.read", group: "Server", label: "View connection details" },
  { id: "session.start", group: "Server", label: "Start a game session" },
  { id: "session.stop", group: "Server", label: "Stop a game session" },
  { id: "invitation.send", group: "Server", label: "Invite players" },
  { id: "console.use", group: "Console", label: "Use the RCON console" },
  { id: "release.read", group: "Storage", label: "View releases" },
  { id: "release.promote", group: "Storage", label: "Promote releases" },
  { id: "backup.read", group: "Storage", label: "View backups" },
  { id: "backup.restore", group: "Storage", label: "Restore backups" },
  { id: "metrics.read", group: "Observability", label: "View metrics and logs" },
  { id: "access.read", group: "Access", label: "View users and roles" },
  { id: "access.manage", group: "Access", label: "Manage users and roles" },
  { id: "access.owner.grant", group: "Access", label: "Grant Owner access" },
];

export const initialRoles: Role[] = [
  {
    id: "viewer", name: "Viewer", system: true,
    description: "Can see the coarse server status only.",
    permissions: ["status.read"],
  },
  {
    id: "player", name: "Player", system: true,
    description: "Can play and control a game session.",
    permissions: ["status.read", "connection.read", "session.start", "invitation.send"],
  },
  {
    id: "operator", name: "Operator", system: true,
    description: "Can operate sessions, console, metrics, releases and backups.",
    permissions: permissions.filter((permission) => permission.group !== "Access").map((permission) => permission.id),
  },
  {
    id: "owner", name: "Owner", system: true,
    description: "Full access to Spawnpoint.",
    permissions: permissions.map((permission) => permission.id),
  },
];
