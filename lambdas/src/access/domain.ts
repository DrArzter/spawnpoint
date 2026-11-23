export const permissions = [
  "status.read",
  "connection.read",
  "session.start",
  "session.stop",
  "session.stop.force",
  "invitation.send",
  "metrics.read",
  "console.use",
  "whitelist.manage",
  "release.read",
  "release.build",
  "release.promote",
  "release.retire",
  "backup.read",
  "backup.download",
  "backup.restore",
  "world.manage",
  "access.read",
  "access.manage",
  "access.invite",
  "access.owner.grant",
] as const;

export type Permission = typeof permissions[number];

/**
 * Held only through the Owner role, never as a direct grant: the last-owner
 * rule counts Owner identities, so a direct holder would escape it.
 */
export const reservedPermissions: readonly Permission[] = ["access.owner.grant"];
export type BuiltInRoleId = "viewer" | "player" | "operator" | "owner";

export type PermissionEntry = Readonly<{ group: string; label: string; description: string }>;

/** What each permission means to a person, served with the role list so no client keeps its own copy. */
const permissionEntries: Readonly<Record<Permission, PermissionEntry>> = {
  "status.read": { group: "Worlds", label: "See status", description: "See whether a game is running." },
  "connection.read": { group: "Worlds", label: "See addresses", description: "See the address a world is reachable at." },
  "metrics.read": { group: "Worlds", label: "Read metrics", description: "Read session metrics." },
  "console.use": { group: "Worlds", label: "Use the console", description: "Run RCON commands, recorded against your identity." },
  "whitelist.manage": { group: "Worlds", label: "Manage the whitelist", description: "Choose which players may join a world." },
  "world.manage": { group: "Worlds", label: "Manage worlds", description: "Create, wipe, archive and permanently delete worlds, and change their game settings." },
  "session.start": { group: "Sessions", label: "Start", description: "Start a session on the shared host." },
  "session.stop": { group: "Sessions", label: "Stop", description: "Stop a session, which saves the world and backs it up first." },
  "session.stop.force": { group: "Sessions", label: "Stop with players online", description: "Stop a session while players are online, which disconnects them." },
  "invitation.send": { group: "Sessions", label: "Invite players", description: "Invite players through the Telegram bot." },
  "release.read": { group: "Releases", label: "See releases", description: "See presets and the releases built from them." },
  "release.build": { group: "Releases", label: "Build", description: "Build releases and retry failed build attempts." },
  "release.promote": { group: "Releases", label: "Promote", description: "Move a world onto another release." },
  "release.retire": { group: "Releases", label: "Retire", description: "Retire a release, so no world can move onto it." },
  "backup.read": { group: "Backups", label: "See backups", description: "List the verified backups of a world." },
  "backup.download": { group: "Backups", label: "Download", description: "Download a world's backup archives, each recorded against your identity." },
  "backup.restore": { group: "Backups", label: "Restore", description: "Restore a backup, which opens a new wipe." },
  "access.read": { group: "Access", label: "See access", description: "See who has access and which role they hold." },
  "access.manage": { group: "Access", label: "Manage access", description: "Approve people, change their roles and delete identities." },
  "access.invite": { group: "Access", label: "Invite people", description: "Invite a person to the panel by email." },
  "access.owner.grant": { group: "Access", label: "Grant Owner", description: "Give or take the Owner role, and add direct grants." },
};

export type CatalogueEntry = PermissionEntry & Readonly<{ id: Permission; reserved: boolean }>;

export const permissionCatalogue: readonly CatalogueEntry[] = permissions.map((id) => ({
  id, ...permissionEntries[id], reserved: reservedPermissions.includes(id),
}));

export type Role = Readonly<{
  id: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** The one role that holds the reserved permissions and must keep a holder. */
  protected: boolean;
}>;

export type Identity = Readonly<{
  id: string;
  displayName: string;
  roleId: string;
  directGrants: readonly Permission[];
}>;

export const builtInRoles: Readonly<Record<BuiltInRoleId, Role>> = {
  viewer: {
    id: "viewer",
    description: "Can see coarse server status only.",
    protected: false,
    name: "Viewer",
    permissions: ["status.read"],
  },
  player: {
    id: "player",
    description: "Can view connection details, start a session and invite players.",
    protected: false,
    name: "Player",
    permissions: ["status.read", "connection.read", "session.start", "invitation.send"],
  },
  operator: {
    id: "operator",
    description: "Can operate sessions, console, metrics, releases and backups.",
    protected: false,
    name: "Operator",
    permissions: [
      "status.read", "connection.read", "session.start", "session.stop", "invitation.send",
      "metrics.read", "console.use", "whitelist.manage", "release.read", "release.build", "backup.read",
    ],
  },
  owner: {
    id: "owner",
    description: "Full access to Spawnpoint, including access management.",
    protected: true,
    name: "Owner",
    permissions,
  },
};

/** The role a newly approved or invited person holds unless the approver picks another. */
export const defaultRoleId: BuiltInRoleId = "viewer";

/** The protected role's id: what the owner bootstrap assigns and the last-holder rule counts. */
export const protectedRoleId: BuiltInRoleId = "owner";

export function isProtectedRoleId(roleId: string): boolean {
  return roleOf({ roleId })?.protected === true;
}

/** The role an identity holds, or null for a role id this deployment does not know. */
export function roleOf(identity: Pick<Identity, "roleId">): Role | null {
  return isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
}

const knownPermissions: ReadonlySet<string> = new Set(permissions);

/**
 * The one permission resolver. An unknown role grants nothing of its own and
 * its direct grants still apply. A reserved permission counts only through the
 * role, so a stored direct grant of one is ignored.
 */
export function permissionsOf(identity: Identity): ReadonlySet<Permission> {
  const direct = identity.directGrants.filter((permission) => knownPermissions.has(permission) && !reservedPermissions.includes(permission));
  return new Set([...(roleOf(identity)?.permissions ?? []), ...direct]);
}

export function can(identity: Identity, permission: Permission): boolean {
  return permissionsOf(identity).has(permission);
}

/** An identity from its stored PROFILE record. */
export function identityFromRecord(item: Readonly<Record<string, unknown>>): Identity {
  return {
    id: String(item.identity_id),
    displayName: String(item.display_name),
    roleId: String(item.role_id),
    directGrants: Array.isArray(item.direct_grants) ? item.direct_grants as Permission[] : [],
  };
}

export function isBuiltInRoleId(value: string): value is BuiltInRoleId {
  return Object.hasOwn(builtInRoles, value);
}
