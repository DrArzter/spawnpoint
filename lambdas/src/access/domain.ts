export const permissions = [
  "status.read",
  "connection.read",
  "session.start",
  "session.stop",
  "invitation.send",
  "metrics.read",
  "console.use",
  "release.read",
  "release.promote",
  "backup.read",
  "backup.restore",
  "world.manage",
  "access.read",
  "access.manage",
  "access.owner.grant",
] as const;

export type Permission = typeof permissions[number];
export type BuiltInRoleId = "viewer" | "player" | "operator" | "owner";

export type Role = Readonly<{
  id: BuiltInRoleId | string;
  name: string;
  permissions: readonly Permission[];
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
    name: "Viewer",
    permissions: ["status.read"],
  },
  player: {
    id: "player",
    name: "Player",
    permissions: ["status.read", "connection.read", "session.start", "invitation.send"],
  },
  operator: {
    id: "operator",
    name: "Operator",
    permissions: [
      "status.read", "connection.read", "session.start", "session.stop", "invitation.send",
      "metrics.read", "console.use", "release.read", "backup.read",
    ],
  },
  owner: {
    id: "owner",
    name: "Owner",
    permissions,
  },
};

export function effectivePermissions(identity: Identity, role: Role): ReadonlySet<Permission> {
  if (identity.roleId !== role.id) throw new Error("identity role does not match the supplied role");
  return new Set([...role.permissions, ...identity.directGrants]);
}

export function hasPermission(identity: Identity, role: Role, permission: Permission): boolean {
  return effectivePermissions(identity, role).has(permission);
}

export function isBuiltInRoleId(value: string): value is BuiltInRoleId {
  return Object.hasOwn(builtInRoles, value);
}
