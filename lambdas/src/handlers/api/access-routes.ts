import { permissionRoute, type Route } from "./routing.ts";
import { roles, candidates, identities, withCandidateAddress, approve, dismiss, updateRole } from "./access.ts";
import { parameter, response } from "./http.ts";

export const accessRoutes: Readonly<Record<string, Route>> = {
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity)),
  "GET /access/candidates": permissionRoute("access.manage", () => candidates()),
  "GET /access/identities": permissionRoute("access.manage", () => identities()),
  "POST /access/candidates/{platform}/{platformUserId}/approve": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => approve(identity, platform, platformUserId, event.body))),
  "POST /access/candidates/{platform}/{platformUserId}/dismiss": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => dismiss(identity, platform, platformUserId))),
  "POST /access/identities/{identityId}/role": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!/^[0-9a-f-]{36}$/.test(identityId)) return response(400, { error: "invalid_identity_id" });
    return updateRole(identity, identityId, event.body);
  })
};
