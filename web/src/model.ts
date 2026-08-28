export type Page = "dashboard" | "metrics" | "console" | "storage" | "access" | "profile";
export type ServerState = "stopped" | "starting" | "running";

export type World = { id: string; title: string; release: string; ready: boolean };
export type Game = { id: string; code: string; title: string; worlds: readonly World[] };

export type Permission = {
  id: string;
  group: "Server" | "Console" | "Storage" | "Observability" | "Access";
  label: string;
};

export type Role = { id: string; name: string; description: string; permissions: string[]; system?: boolean };
export type LinkKind = "telegram" | "discord" | "minecraft" | "factorio" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
export type Member = { id: number; name: string; roleId: string; links: LinkedAccount[] };
export type OwnerBootstrap =
  | { state: "unclaimed"; email: string }
  | { state: "claimed"; email: string; ownerId: number; claimedAt: string };

export const games: readonly Game[] = [
  {
    id: "minecraft", code: "MC", title: "Minecraft",
    worlds: [
      { id: "modded-survival", title: "Modded survival", release: "1.0", ready: true },
      { id: "vanilla", title: "Vanilla", release: "Draft", ready: false },
    ],
  },
  { id: "factorio", code: "FA", title: "Factorio", worlds: [{ id: "factorio-vanilla", title: "Vanilla", release: "2.0.77", ready: true }] },
  { id: "zomboid", code: "PZ", title: "Project Zomboid", worlds: [{ id: "zomboid-dedicated", title: "Dedicated server", release: "Draft", ready: false }] },
];

export const permissions: readonly Permission[] = [
  { id: "server.view", group: "Server", label: "View server state" },
  { id: "server.start", group: "Server", label: "Start server" },
  { id: "server.stop", group: "Server", label: "Stop server" },
  { id: "console.view", group: "Console", label: "View RCON output" },
  { id: "console.execute", group: "Console", label: "Execute RCON commands" },
  { id: "releases.view", group: "Storage", label: "View releases" },
  { id: "releases.promote", group: "Storage", label: "Promote releases" },
  { id: "backups.view", group: "Storage", label: "View backups" },
  { id: "backups.restore", group: "Storage", label: "Restore backups" },
  { id: "metrics.view", group: "Observability", label: "View metrics and logs" },
  { id: "access.manage", group: "Access", label: "Manage users and roles" },
];

export const initialRoles: Role[] = [
  {
    id: "player", name: "Player", system: true,
    description: "Can play and control a game session.",
    permissions: ["server.view", "server.start", "server.stop", "metrics.view"],
  },
  {
    id: "owner", name: "Owner", system: true,
    description: "Full access to Spawnpoint.",
    permissions: permissions.map((permission) => permission.id),
  },
];

export const initialMembers: Member[] = [
  {
    id: 1,
    name: "DrArzter",
    roleId: "owner",
    links: [
      { id: "link-1", kind: "telegram", value: "1780660807", verified: true },
      { id: "link-2", kind: "minecraft", value: "DrArzter", verified: true },
      { id: "link-3", kind: "zerotier", value: "b9bc15e2cf", verified: true },
    ],
  },
  {
    id: 2,
    name: "Alex",
    roleId: "player",
    links: [{ id: "link-4", kind: "telegram", value: "381204700", verified: true }],
  },
];

export const initialOwnerBootstrap: OwnerBootstrap = {
  state: "claimed",
  email: "drarzter@example.com",
  ownerId: 1,
  claimedAt: "27 Aug 2026, 18:42",
};
