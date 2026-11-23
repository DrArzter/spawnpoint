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

export type Role = Readonly<{
  id: string;
  name: string;
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
    protected: false,
    name: "Viewer",
    permissions: ["status.read"],
  },
  player: {
    id: "player",
    protected: false,
    name: "Player",
    permissions: ["status.read", "connection.read", "session.start", "invitation.send"],
  },
  operator: {
    id: "operator",
    protected: false,
    name: "Operator",
    permissions: [
      "status.read", "connection.read", "session.start", "session.stop", "invitation.send",
      "metrics.read", "console.use", "whitelist.manage", "release.read", "release.build", "backup.read",
    ],
  },
  owner: {
    id: "owner",
    protected: true,
    name: "Owner",
    permissions,
  },
};

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
