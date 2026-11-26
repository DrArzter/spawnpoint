import type { SettingDefinition, SettingValue } from "../../contract/settings";
import type { AccessPermission, AccessRole } from "../../contract/access";
import type { ControlPlaneSnapshot, Deployment, Game, GamePresentation, Host, Operation, Preset, ReleasePointer, Wipe, World, WorldGameSettings, WorldSession } from "../../contract/control-plane";

/** One setting a world of this game may set, as its game module defines it (contract/settings.ts). */
export type { SettingDefinition, SettingValue };
/** What GET /control-plane sends (contract/control-plane.ts). */
export type { ControlPlaneSnapshot, Deployment, Game, GamePresentation, Host, Operation, Preset, ReleasePointer, Wipe, World, WorldGameSettings, WorldSession };
export type Page = "worlds" | "releases" | "access" | "profile";
export type AccessTab = "users" | "roles" | "notifications";
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "moving" | "unknown";

/** A world's console and metrics are its own: several worlds of a game can run at once (ADR-0062). */
export type WorldTab = "details" | "wipes" | "backups" | "releases" | "whitelist" | "config" | "console" | "log" | "metrics";

/** A role as the API serves it; `assignable` is the caller's own reading, so a skin never works out who may give what. */
export type Role = AccessRole;
/** One permission of the served catalogue: the words every skin shows for it. */
export type PermissionInfo = AccessPermission;
export type LinkKind = "telegram" | "email" | "google" | "discord" | "steam" | "zerotier";
export type LinkedAccount = { id: string; kind: LinkKind; value: string; verified: boolean };
/** `canDelete` is the backend's answer for this caller, not a rule the web works out. */
export type Member = { id: string; name: string; roleId: string; links: LinkedAccount[]; canDelete: boolean; photoUrl?: string | null };
export type OwnerBootstrap =
  /** The viewer's own Telegram id, when they have one; the configured account is deployment configuration. */
  | { state: "unclaimed"; telegramId: string | null }
  | { state: "claimed"; telegramId: string | null; ownerId: string; claimedAt: string };
