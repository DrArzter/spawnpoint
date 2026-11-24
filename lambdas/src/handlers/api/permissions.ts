import { type Identity, type Permission, can } from "../../access/domain.ts";
import { type Response, response, errorResponse } from "./http.ts";

export function requirePermission(identity: Identity, permission: Permission): Response | null {
  return can(identity, permission) ? null : errorResponse(403, "forbidden");
}
