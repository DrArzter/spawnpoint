import { type Identity, type Permission, can } from "../../access/domain.ts";
import { type Response, response } from "./http.ts";

export function requirePermission(identity: Identity, permission: Permission): Response | null {
  return can(identity, permission) ? null : response(403, { error: "forbidden" });
}
