import { permissionRoute, type Route } from "./routing.ts";
import { candidates, identities, withCandidateAddress, approve, dismiss, updateRole } from "./access.ts";
import { roles, createRoleHandler, updateRoleHandler, deleteRoleHandler, setDefaultRoleHandler } from "./roles.ts";
import { ROLE_ID } from "../../access/roles.ts";
import { deleteIdentity } from "./identity-deletion.ts";
import { type Event, type Response, parameter, response, errorResponse } from "./http.ts";

function withRoleId(event: Event, handle: (roleId: string) => Promise<Response> | Response): Promise<Response> | Response {
  const roleId = parameter(event, "roleId");
  return ROLE_ID.test(roleId) ? handle(roleId) : errorResponse(400, "invalid_role");
}

const IDENTITY_ID = /^[0-9a-f-]{36}$/;

const VERSION = { type: "integer", minimum: 1, description: "The role's version from list_roles, so a role changed meanwhile is refused" } as const;
const ROLE_INPUT = {
      name: { type: "string", minLength: 1, maxLength: 60, description: "The role's name" },
      description: { type: "string", maxLength: 200, description: "What the role is for" },
      permissions: { type: "array", items: { type: "string" }, description: "Permission ids from list_roles' catalogue; you can give only permissions you hold" },
    } as const;

export const accessRoutes: Readonly<Record<string, Route>> = {
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity), {
    name: "list_roles", title: "List roles", effect: "read",
    description: "List the panel's roles with their permissions, who holds each, the default role, and the catalogue of permissions.",
  }),
  "POST /access/roles": permissionRoute("access.manage", (identity, event) => createRoleHandler(identity, event.body), {
    name: "create_role", title: "Create role", effect: "write",
    description: "Create a panel role with a set of permissions.",
    input: { id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$", description: "The role's id, lowercase" }, ...ROLE_INPUT },
    required: ["id", "name", "permissions"],
  }),
  "POST /access/roles/{roleId}": permissionRoute("access.manage", (identity, event) =>
    withRoleId(event, (roleId) => updateRoleHandler(identity, roleId, event.body)), {
    name: "update_role", title: "Change role", effect: "write",
    description: "Change a role's name, description and permissions. Everyone holding it is affected at once.",
    input: { version: VERSION, ...ROLE_INPUT },
    required: ["version", "name", "permissions"],
  }),
  "POST /access/roles/{roleId}/delete": permissionRoute("access.manage", (identity, event) =>
    withRoleId(event, (roleId) => deleteRoleHandler(identity, roleId, event.body)), {
    name: "delete_role", title: "Delete role", effect: "write", destructive: true,
    description: "Delete a role nobody holds and that is not the default.",
    input: { version: VERSION },
    required: ["version"],
  }),
  "POST /access/defaults": permissionRoute("access.manage", (identity, event) => setDefaultRoleHandler(identity, event.body), {
    name: "set_default_role", title: "Set default role", effect: "write",
    description: "Choose the role every newly approved person gets.",
    input: { defaultRoleId: { type: "string", description: "Role ID from list_roles" } },
    required: ["defaultRoleId"],
  }),
  "GET /access/candidates": permissionRoute("access.manage", () => candidates(), {
    name: "list_access_candidates", title: "List access requests", effect: "read",
    description: "List the accounts waiting for access to the panel.",
  }),
  "GET /access/identities": permissionRoute("access.manage", (identity) => identities(identity), {
    name: "list_identities", title: "List people", effect: "read",
    description: "List the people with access to the panel, their roles, direct grants and linked accounts.",
  }),
  "POST /access/candidates/{platform}/{platformUserId}/approve": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => approve(identity, platform, platformUserId, event.body)), {
    name: "approve_access_request", title: "Approve access request", effect: "write",
    description: "Give a waiting account access to the panel with a role, and optionally direct grants.",
    input: {
      roleId: { type: "string", description: "Role ID from list_roles; left out, the default role" },
      directGrants: { type: "array", items: { type: "string" }, description: "Permission ids given on top of the role" },
    },
  }),
  "POST /access/candidates/{platform}/{platformUserId}/dismiss": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => dismiss(identity, platform, platformUserId)), {
    name: "dismiss_access_request", title: "Dismiss access request", effect: "write",
    description: "Dismiss a waiting account's request for access.",
  }),
  "POST /access/identities/{identityId}/role": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!IDENTITY_ID.test(identityId)) return errorResponse(400, "invalid_identity_id");
    return updateRole(identity, identityId, event.body);
  }, {
    name: "change_person_role", title: "Change a person's role", effect: "write",
    description: "Give a person another role. You cannot change your own role, nor remove the last Owner.",
    input: { roleId: { type: "string", description: "Role ID from list_roles" } },
    required: ["roleId"],
  }),
  "POST /access/identities/{identityId}/delete": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!IDENTITY_ID.test(identityId)) return errorResponse(400, "invalid_identity_id");
    return deleteIdentity(identity, identityId);
  }, {
    name: "delete_person", title: "Delete person", effect: "write", destructive: true,
    description: "Delete a person's identity and access, and remove their name from what they did.",
  }),
};
