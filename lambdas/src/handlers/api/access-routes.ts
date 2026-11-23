import { permissionRoute, type Route } from "./routing.ts";
import { candidates, identities, withCandidateAddress, approve, dismiss, updateRole } from "./access.ts";
import { roles, createRoleHandler, updateRoleHandler, deleteRoleHandler, setDefaultRoleHandler } from "./roles.ts";
import { ROLE_ID } from "../../access/roles.ts";
import { deleteIdentity } from "./identity-deletion.ts";
import { type Event, type Response, parameter, response } from "./http.ts";

function withRoleId(event: Event, handle: (roleId: string) => Promise<Response> | Response): Promise<Response> | Response {
  const roleId = parameter(event, "roleId");
  return ROLE_ID.test(roleId) ? handle(roleId) : response(400, { error: "invalid_role" });
}

const IDENTITY_ID = /^[0-9a-f-]{36}$/;

export const accessRoutes: Readonly<Record<string, Route>> = {
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity)),
  "POST /access/roles": permissionRoute("access.manage", (identity, event) => createRoleHandler(identity, event.body)),
  "POST /access/roles/{roleId}": permissionRoute("access.manage", (identity, event) =>
    withRoleId(event, (roleId) => updateRoleHandler(identity, roleId, event.body))),
  "POST /access/roles/{roleId}/delete": permissionRoute("access.manage", (identity, event) =>
    withRoleId(event, (roleId) => deleteRoleHandler(identity, roleId, event.body))),
  "POST /access/defaults": permissionRoute("access.manage", (identity, event) => setDefaultRoleHandler(identity, event.body)),
  "GET /access/candidates": permissionRoute("access.manage", () => candidates()),
  "GET /access/identities": permissionRoute("access.manage", (identity) => identities(identity)),
  "POST /access/candidates/{platform}/{platformUserId}/approve": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => approve(identity, platform, platformUserId, event.body))),
  "POST /access/candidates/{platform}/{platformUserId}/dismiss": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => dismiss(identity, platform, platformUserId))),
  "POST /access/identities/{identityId}/role": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!IDENTITY_ID.test(identityId)) return response(400, { error: "invalid_identity_id" });
    return updateRole(identity, identityId, event.body);
  }),
  "POST /access/identities/{identityId}/delete": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!IDENTITY_ID.test(identityId)) return response(400, { error: "invalid_identity_id" });
    return deleteIdentity(identity, identityId);
  })
};
