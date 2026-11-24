import { type Identity, can, isProtectedRoleId, permissionCatalogue } from "../../access/domain.ts";
import { ROLE_ID, type StoredRole, holdsAll, parseRoleInput } from "../../access/roles.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";
import { canAssign } from "./owner-guard.ts";
import {
  createRole, deleteRole, listRoles, readDefaultRoleId, readRole, roleHolders, updateRole, writeDefaultRoleId,
} from "./role-store.ts";
import type { AccessRole, AccessRoleDirectory, RoleDefinition } from "../../../../contract/access.ts";

// Panel roles as owner-defined data (ADR-0083). Every write is under
// access.manage at the route; here each one is checked against no escalation:
// the caller holds every permission of the role, before and after.

/** What the caller may do with a role. The web reads these and keeps no copy of the rules. */
function rights(caller: Identity, role: StoredRole, holders: number, defaultRoleId: string) {
  const editable = can(caller, "access.manage") && !role.protected && holdsAll(caller, role.permissions);
  return {
    assignable: canAssign(caller, role),
    editable,
    deletable: editable && !role.builtIn && holders === 0 && role.id !== defaultRoleId,
  };
}

export async function roles(caller: Identity): Promise<Response> {
  const [list, holders, defaultRoleId] = await Promise.all([listRoles(), roleHolders(), readDefaultRoleId()]);
  const body: AccessRoleDirectory = {
    roles: list.map((role): AccessRole => {
      const held = holders.get(role.id) ?? 0;
      return { ...definition(role), holders: held, ...rights(caller, role, held, defaultRoleId) };
    }),
    permissions: permissionCatalogue,
    defaultRoleId,
  };
  return response(200, body);
}

/** A role as the API shows it, named field by field. */
function definition(role: StoredRole): RoleDefinition {
  return { id: role.id, name: role.name, description: role.description, permissions: role.permissions, builtIn: role.builtIn, protected: role.protected, version: role.version };
}

function served(role: StoredRole): Response {
  return response(200, { role: definition(role) });
}

export async function createRoleHandler(caller: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const roleId = typeof parsed.id === "string" ? parsed.id : "";
  if (!ROLE_ID.test(roleId)) return errorResponse(400, "invalid_role");
  const input = parseRoleInput(parsed);
  if (typeof input === "string") return errorResponse(400, input);
  if (!holdsAll(caller, input.permissions)) return errorResponse(403, "forbidden");
  const written = await createRole(roleId, input, caller.id);
  return "conflict" in written ? errorResponse(409, written.conflict) : response(201, { role: definition(written.role) });
}

function versionOf(parsed: Readonly<Record<string, unknown>>): number | null {
  return typeof parsed.version === "number" && Number.isSafeInteger(parsed.version) && parsed.version > 0 ? parsed.version : null;
}

export async function updateRoleHandler(caller: Identity, roleId: string, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const version = versionOf(parsed);
  const input = parseRoleInput(parsed);
  if (version === null) return errorResponse(400, "invalid_role");
  if (typeof input === "string") return errorResponse(400, input);
  if (isProtectedRoleId(roleId)) return errorResponse(409, "role_protected");
  const current = await readRole(roleId);
  if (current === null) return errorResponse(404, "unknown_role");
  // The permissions it loses and the ones it gains are both the caller's to give.
  if (!holdsAll(caller, [...current.permissions, ...input.permissions])) return errorResponse(403, "forbidden");
  const written = await updateRole(current, input, version, caller.id);
  return "conflict" in written ? errorResponse(409, written.conflict) : served(written.role);
}

export async function deleteRoleHandler(caller: Identity, roleId: string, body: string | undefined): Promise<Response> {
  const version = versionOf(parseJsonObject({ body }));
  if (version === null) return errorResponse(400, "invalid_role");
  if (isProtectedRoleId(roleId)) return errorResponse(409, "role_protected");
  const current = await readRole(roleId);
  if (current === null) return response(204, null);
  if (current.builtIn) return errorResponse(409, "role_built_in");
  if (!holdsAll(caller, current.permissions)) return errorResponse(403, "forbidden");
  if (version !== current.version) return errorResponse(409, "role_changed");
  const [holders, defaultRoleId] = await Promise.all([roleHolders(), readDefaultRoleId()]);
  if ((holders.get(roleId) ?? 0) > 0 || defaultRoleId === roleId) return errorResponse(409, "role_in_use");
  return await deleteRole(roleId, version) === "deleted" ? response(204, null) : errorResponse(409, "role_changed");
}

export async function setDefaultRoleHandler(caller: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const roleId = typeof parsed.defaultRoleId === "string" ? parsed.defaultRoleId : "";
  if (isProtectedRoleId(roleId)) return errorResponse(409, "role_protected");
  const role = roleId === "" ? null : await readRole(roleId);
  if (role === null) return errorResponse(400, "unknown_role");
  // Choosing the role every new person gets is giving that role.
  if (!holdsAll(caller, role.permissions)) return errorResponse(403, "forbidden");
  await writeDefaultRoleId(roleId, caller.id);
  return response(200, { defaultRoleId: roleId });
}
