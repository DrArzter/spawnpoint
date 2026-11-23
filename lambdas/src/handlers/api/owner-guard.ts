import { type Identity, type Role, can, isProtectedRoleId, protectedRoleId } from "../../access/domain.ts";
import { holdsAll } from "../../access/roles.ts";
import { type Response, response } from "./http.ts";
import { profileKey } from "../../access/keys.ts";
import { activeOwnerCount } from "./identity-store.ts";

// The rules for every change to who holds which role (ADR-0083). No escalation:
// the caller holds every permission of each role involved, so only a holder of
// the protected role, which holds every permission, may give, take or delete
// it. And the protected role keeps a holder.

/** A 403 when the caller does not hold every permission of these roles. An unknown role involves none. */
export function escalationRefusal(caller: Identity, roles: readonly (Role | null)[]): Response | null {
  return holdsAll(caller, roles.flatMap((role) => role?.permissions ?? [])) ? null : response(403, { error: "forbidden" });
}

/** A 409 when the change would leave no active holder of the protected role. */
export async function lastHolderRefusal(fromRoleId: string, toRoleId: string | null): Promise<Response | null> {
  if (!isProtectedRoleId(fromRoleId) || (toRoleId !== null && isProtectedRoleId(toRoleId))) return null;
  return await activeOwnerCount() <= 1 ? response(409, { error: "last_owner" }) : null;
}

/**
 * The condition on the caller's own profile inside the write: still active, and
 * still a holder of the protected role when the target holds it. Two holders
 * who remove each other at once cannot both succeed.
 */
export function callerCondition(caller: Identity, targetRoleId: string) {
  const guarded = isProtectedRoleId(targetRoleId);
  return {
    Key: profileKey(caller.id),
    ConditionExpression: guarded ? "#status = :active AND role_id = :protected" : "#status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: guarded ? { ":active": "ACTIVE", ":protected": protectedRoleId } : { ":active": "ACTIVE" },
  };
}

/** Whether the caller may delete the target, by the rules the delete route applies. */
export function canDelete(caller: Identity, target: Readonly<{ id: string; role: Role | null }>): boolean {
  return target.id !== caller.id && can(caller, "access.manage") && escalationRefusal(caller, [target.role]) === null;
}

/** Whether the caller may give this role, by the rules the role change and approval routes apply. */
export function canAssign(caller: Identity, role: Role): boolean {
  return can(caller, "access.manage") && escalationRefusal(caller, [role]) === null;
}
