import type { PermissionInfo, Role } from "../model";

/** Everything the API serves about roles: who may be given which, the permission words, and the role an approval gives. */
export type RoleDirectory = Readonly<{
  roles: readonly Role[];
  permissions: readonly PermissionInfo[];
  /** Null until the role list has loaded. */
  defaultRoleId: string | null;
}>;

/** What a role select draws: the roles the caller may give, and the value held now. */
export type RoleChoice = Readonly<{
  value: string;
  options: readonly Readonly<{ value: string; label: string }>[];
  disabled: boolean;
}>;

/**
 * The roles offered are exactly those the API marks `assignable`. A value that
 * is not among them (a role the caller may not take away) is shown alone and
 * locked, so the select never claims a role it cannot keep.
 */
export function roleChoice(roles: readonly Role[], value: string, busy: boolean): RoleChoice {
  const options = roles.filter((role) => role.assignable).map((role) => ({ value: role.id, label: role.name }));
  if (options.some((option) => option.value === value)) return { value, options, disabled: busy };
  return { value, options: [{ value, label: roles.find((role) => role.id === value)?.name ?? (value || "Loading roles…") }], disabled: true };
}

/** The name of the protected role, which the owner bootstrap hands out. */
export function protectedRoleName(roles: readonly Role[]): string | null {
  return roles.find((role) => role.protected)?.name ?? null;
}

/** A permission as the catalogue words it; an id the catalogue lacks still shows, as itself. */
export function permissionInfo(catalogue: readonly PermissionInfo[], id: string): PermissionInfo {
  return catalogue.find((entry) => entry.id === id) ?? { id, group: "Other", label: id, description: "", reserved: false };
}

/** Every catalogue permission in catalogue order (which is grouped), then any id a role holds that the catalogue lacks. */
export function permissionRows(catalogue: readonly PermissionInfo[], roles: readonly Role[]): PermissionInfo[] {
  const known = new Set(catalogue.map((entry) => entry.id));
  const extra = [...new Set(roles.flatMap((role) => role.permissions))].filter((id) => !known.has(id)).sort((a, b) => a.localeCompare(b));
  return [...catalogue, ...extra.map((id) => permissionInfo(catalogue, id))];
}

/** A role's permissions in catalogue order. */
export function rolePermissions(catalogue: readonly PermissionInfo[], role: Role): PermissionInfo[] {
  const order = new Map(permissionRows(catalogue, [role]).map((entry, index) => [entry.id, index]));
  return role.permissions.map((id) => permissionInfo(catalogue, id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
