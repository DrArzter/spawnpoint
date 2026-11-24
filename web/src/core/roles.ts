import type { PermissionInfo, Role } from "../model";
import type { RoleChoice, RoleEditorModel } from "./models";

/** Everything the API serves about roles: who may be given which, the permission words, and the role an approval gives. */
export type RoleDirectory = Readonly<{
  roles: readonly Role[];
  permissions: readonly PermissionInfo[];
  /** Null until the role list has loaded. */
  defaultRoleId: string | null;
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

/** A role id as the API accepts it: a lower-case slug of up to 32 characters. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The tooltip of the id field. */
export const ROLE_ID_HINT = "It names the role in the API and cannot change later.";

/** What each text field of the role form takes, the same in every skin: the API's limits (name 40, id 32, description 200) and the model's setters. */
export function roleFormFields(model: RoleEditorModel) {
  const text = (value: string, set: (value: string) => void, maxLength: number) => ({ autoComplete: "off", maxLength, value, onChange: (event: { target: { value: string } }) => set(event.target.value) });
  return {
    name: text(model.name, model.setName, 40),
    id: { ...text(model.id, model.setId, 32), spellCheck: false },
    description: text(model.description, model.setDescription, 200),
  };
}

/** A slug for a name, until the person types an id of their own. */
export function roleIdFor(name: string): string {
  let slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug;
}

/** The roles an owner may name as the default: never the protected one. */
export function defaultRoleOptions(roles: readonly Role[]): readonly Readonly<{ value: string; label: string }>[] {
  return roles.filter((role) => !role.protected).map((role) => ({ value: role.id, label: role.name }));
}

/** The default-role select: the non-protected roles, locked while it is busy, unreadable or not the caller's to change. */
export function defaultRoleChoice(roles: readonly Role[], value: string | null, disabled: boolean): RoleChoice {
  const options = defaultRoleOptions(roles);
  const current = value ?? "";
  if (options.some((option) => option.value === current)) return { value: current, options, disabled };
  return { value: current, options: [{ value: current, label: roles.find((role) => role.id === current)?.name ?? (current || "Loading roles…") }], disabled: true };
}

/** Why a role cannot be edited, or null. The API's `editable` decides; the words only say why. */
export function roleEditRefusal(role: Role): string | null {
  if (role.editable) return null;
  return role.protected ? "This role cannot be changed." : "You cannot change this role.";
}

/** Why a role cannot be deleted, or null. The API's `deletable` decides; the words only say why. */
export function roleDeleteRefusal(role: Role, defaultRoleId: string | null = null): string | null {
  if (role.deletable) return null;
  if (role.protected) return "This role cannot be deleted.";
  if (role.builtIn) return "A built-in role cannot be deleted.";
  if (role.id === defaultRoleId) return "This is the default role. Choose another first.";
  if (role.holders > 0) return `${role.holders} ${role.holders === 1 ? "person holds" : "people hold"} this role. Move them first.`;
  return "You cannot delete this role.";
}

/** One permission the editor draws: the catalogue's words and whether the caller may change it. */
export type OfferedPermission = Readonly<{ permission: PermissionInfo; locked: boolean }>;

/**
 * What the editor offers: every permission except a reserved one, which no
 * role but the protected one holds. A permission the caller does not hold is
 * shown but locked, because the API refuses a change to it.
 */
export function offeredPermissions(catalogue: readonly PermissionInfo[], held: ReadonlySet<string>): OfferedPermission[] {
  return catalogue.filter((entry) => !entry.reserved).map((permission) => ({ permission, locked: !held.has(permission.id) }));
}

/** Rows under their catalogue group, in catalogue order. */
export function permissionGroups<Row extends Readonly<{ permission: PermissionInfo }>>(rows: readonly Row[]): readonly Readonly<{ group: string; rows: readonly Row[] }>[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.permission.group, [...(groups.get(row.permission.group) ?? []), row]);
  return [...groups].map(([group, members]) => ({ group, rows: members }));
}

/** A role's permissions in catalogue order. */
export function rolePermissions(catalogue: readonly PermissionInfo[], role: Role): PermissionInfo[] {
  const order = new Map(permissionRows(catalogue, [role]).map((entry, index) => [entry.id, index]));
  return role.permissions.map((id) => permissionInfo(catalogue, id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
