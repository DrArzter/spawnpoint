import {
  type Identity, type Permission, type Role, builtInRoles, isBuiltInRoleId, isProtectedRoleId, permissions, permissionsOf,
  reservedPermissions,
} from "./domain.ts";

// Panel roles as owner-defined data (ADR-0083): what a stored role is, what a
// write may contain, and who may make it. No I/O here; the API and the bot
// read and write the records.

export type StoredRole = Role & Readonly<{ builtIn: boolean; version: number }>;

/** A built-in role with no record uses its definition in code, at version 1. */
const BUILT_IN_VERSION = 1;

const knownPermissions: ReadonlySet<string> = new Set(permissions);

/** The role with this id from its record, its built-in definition, or null. The protected role is always code. */
export function resolveRole(roleId: string, item: Readonly<Record<string, unknown>> | undefined): StoredRole | null {
  const builtIn = isBuiltInRoleId(roleId);
  if (isProtectedRoleId(roleId) || (item === undefined && builtIn)) {
    return builtIn ? { ...builtInRoles[roleId], builtIn: true, version: BUILT_IN_VERSION } : null;
  }
  if (item === undefined) return null;
  return {
    id: roleId,
    name: String(item.name ?? roleId),
    description: typeof item.description === "string" ? item.description : "",
    // A stored role never grants a reserved or an unknown permission, whatever its record holds.
    permissions: (Array.isArray(item.permissions) ? item.permissions : [])
      .filter((value): value is Permission => typeof value === "string" && knownPermissions.has(value) && !reservedPermissions.includes(value as Permission)),
    protected: false,
    builtIn,
    version: typeof item.version === "number" ? item.version : BUILT_IN_VERSION,
  };
}

export const ROLE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;

export type RoleInput = Readonly<{ name: string; description: string; permissions: readonly Permission[] }>;

/** The editable part of a role from a request body, or the refusal code. */
export function parseRoleInput(body: Readonly<Record<string, unknown>>): RoleInput | "invalid_role" | "reserved_permission" {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME || description.length > MAX_DESCRIPTION) return "invalid_role";
  if (!Array.isArray(body.permissions) || !body.permissions.every((value) => typeof value === "string" && knownPermissions.has(value))) {
    return "invalid_role";
  }
  const chosen = [...new Set(body.permissions as Permission[])];
  if (chosen.some((permission) => reservedPermissions.includes(permission))) return "reserved_permission";
  // Kept in catalogue order, so a role's list reads the same however it was sent.
  return { name, description, permissions: permissions.filter((permission) => chosen.includes(permission)) };
}

/** No escalation: the caller holds every permission involved. */
export function holdsAll(caller: Identity, involved: readonly Permission[]): boolean {
  const held = permissionsOf(caller);
  return involved.every((permission) => held.has(permission));
}
