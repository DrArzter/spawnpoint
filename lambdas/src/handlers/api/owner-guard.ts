import { type Identity, can, isProtectedRoleId, protectedRoleId } from "../../access/domain.ts";
import { type Response, response } from "./http.ts";
import { requirePermission } from "./permissions.ts";
import { activeOwnerCount } from "./identity-store.ts";

// One rule for every change that touches the protected role: only a holder of
// the reserved permission may give, take or delete it, and it keeps a holder.

/** A refusal when any of these roles is the protected one and the caller may not grant it. */
export function protectedRoleRefusal(caller: Identity, roleIds: readonly string[]): Response | null {
  return roleIds.some(isProtectedRoleId) ? requirePermission(caller, "access.owner.grant") : null;
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
    Key: { pk: `IDENTITY#${caller.id}`, sk: "PROFILE" },
    ConditionExpression: guarded ? "#status = :active AND role_id = :protected" : "#status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: guarded ? { ":active": "ACTIVE", ":protected": protectedRoleId } : { ":active": "ACTIVE" },
  };
}

/** Whether the caller may delete the target, by the rules the delete route applies. */
export function canDelete(caller: Identity, target: Readonly<{ id: string; roleId: string }>): boolean {
  return target.id !== caller.id && can(caller, "access.manage")
    && (!isProtectedRoleId(target.roleId) || can(caller, "access.owner.grant"));
}

/** Whether the caller may give this role, by the rules the role change and approval routes apply. */
export function canAssign(caller: Identity, roleId: string): boolean {
  return can(caller, "access.manage") && protectedRoleRefusal(caller, [roleId]) === null;
}
