import { type Identity, type Permission, isBuiltInRoleId, builtInRoles, hasPermission } from "../../access/domain.ts";
import { type Response, response } from "./http.ts";

export function requirePermission(identity: Identity, permission: Permission): Response | null {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission) ? null : response(403, { error: "forbidden" });
}
