import { identityDeletionRefusal, type AccessCandidate, type AccessIdentity, type AccessInvitation, type AccessRole, type AccessRoleDirectory, type AccessRoleDraft, type SpawnpointApi } from "../contract";
import { request } from "./request";

// Where a role change reads differently from the shared text (error-text.ts).
const ROLE_CHANGE_REFUSALS = {
  last_owner: "This is the last Owner. Make someone else an Owner first.",
  forbidden: "Only an Owner can give or take the Owner role.",
};

// A role write is refused for a permission the caller does not hold, not for a missing role.
const ROLE_WRITE_REFUSALS = { forbidden: "You can give a role only permissions you hold." };

const DELETION_REFUSALS = {
  self_delete_forbidden: identityDeletionRefusal(409, "self_delete_forbidden"),
  last_owner: identityDeletionRefusal(409, "last_owner"),
  forbidden: identityDeletionRefusal(403, "forbidden"),
};

const roleRoute = (roleId: string) => `/access/roles/${encodeURIComponent(roleId)}`;
const candidatePath = (platform: string, platformUserId: string) => `/access/candidates/${encodeURIComponent(platform)}/${encodeURIComponent(platformUserId)}`;

// Project membership and roles. Player-to-player invitations belong to the
// game client, not this access-invitation flow.
export const accessApi = {
  async requestAccess(): Promise<void> {
    await request<unknown>("/access/request", { method: "POST", failure: "The access request could not be sent." });
  },

  async checkAccessInvitation(token: string): Promise<{ valid: boolean; email: string | null }> {
    const body = await request<{ valid?: unknown; email?: unknown }>("/auth/access-invitations/check", { method: "POST", renew: false, body: { token }, failure: "This invitation could not be checked." });
    return { valid: body.valid === true, email: typeof body.email === "string" ? body.email : null };
  },

  async redeemAccessInvitation(token: string, proof?: string): Promise<void> {
    await request<unknown>("/access/invitations/redeem", { method: "POST", body: { token, ...(proof ? { proof } : {}) }, failure: "This invitation could not be accepted." });
  },

  async requestAccessInvitationProof(token: string): Promise<void> {
    await request<unknown>("/access/invitations/proof", { method: "POST", body: { token }, failure: "The confirmation email could not be sent." });
  },

  async loadAccessInvitations(): Promise<AccessInvitation[]> {
    const body = await request<{ invitations: AccessInvitation[] }>("/access/invitations", { failure: "Invitations could not be loaded." });
    return body.invitations;
  },

  createAccessInvitation(email: string | null) {
    return request<Awaited<ReturnType<SpawnpointApi["createAccessInvitation"]>>>("/access/invitations", {
      method: "POST", body: email === null ? {} : { email }, failure: "An invitation could not be created.",
    });
  },

  async revokeAccessInvitation(id: string): Promise<void> {
    await request<unknown>(`/access/invitations/${encodeURIComponent(id)}/revoke`, { method: "POST", failure: "This invitation could not be revoked." });
  },

  async loadAccessCandidates(): Promise<AccessCandidate[]> {
    const body = await request<{ candidates: AccessCandidate[] }>("/access/candidates", { failure: "Access requests could not be loaded." });
    return body.candidates;
  },

  async approveAccessCandidate(platform: string, platformUserId: string, roleId?: string) {
    const body = await request<{ identity: { id: string; displayName: string; roleId: string } }>(`${candidatePath(platform, platformUserId)}/approve`, {
      method: "POST", body: roleId === undefined ? {} : { roleId }, failure: "This account could not be approved.",
    });
    return body.identity;
  },

  async dismissAccessCandidate(platform: string, platformUserId: string): Promise<void> {
    await request<unknown>(`${candidatePath(platform, platformUserId)}/dismiss`, { method: "POST", failure: "This account could not be dismissed." });
  },

  async loadAccessIdentities(): Promise<AccessIdentity[]> {
    const body = await request<{ identities: AccessIdentity[] }>("/access/identities", { failure: "Users could not be loaded." });
    return body.identities;
  },

  loadAccessRoles(): Promise<AccessRoleDirectory> {
    return request<AccessRoleDirectory>("/access/roles", { failure: "Roles could not be loaded.", refusals: { forbidden: "Your role cannot view access roles." } });
  },

  async createAccessRole(id: string, draft: AccessRoleDraft): Promise<AccessRole> {
    const body = await request<{ role: AccessRole }>("/access/roles", { method: "POST", body: { id, ...draft }, failure: "The role could not be created.", refusals: ROLE_WRITE_REFUSALS });
    return body.role;
  },

  async updateAccessRole(roleId: string, draft: AccessRoleDraft, version: number): Promise<AccessRole> {
    const body = await request<{ role: AccessRole }>(roleRoute(roleId), { method: "POST", body: { ...draft, version }, failure: "The role could not be saved.", refusals: ROLE_WRITE_REFUSALS });
    return body.role;
  },

  async deleteAccessRole(roleId: string, version: number): Promise<void> {
    await request<unknown>(`${roleRoute(roleId)}/delete`, { method: "POST", body: { version }, failure: "The role could not be deleted.", refusals: ROLE_WRITE_REFUSALS });
  },

  async updateDefaultRole(roleId: string): Promise<string> {
    const body = await request<{ defaultRoleId: string }>("/access/defaults", { method: "POST", body: { defaultRoleId: roleId }, failure: "The default role could not be changed." });
    return body.defaultRoleId;
  },

  async updateIdentityRole(identityId: string, roleId: string): Promise<void> {
    await request<unknown>(`/access/identities/${encodeURIComponent(identityId)}/role`, {
      method: "POST", body: { roleId }, failure: "The role could not be changed.", refusals: ROLE_CHANGE_REFUSALS,
    });
  },

  async deleteIdentity(identityId: string): Promise<void> {
    await request<unknown>(`/access/identities/${encodeURIComponent(identityId)}/delete`, {
      method: "POST", failure: "This user could not be deleted.", refusals: DELETION_REFUSALS,
    });
  },
} satisfies Partial<SpawnpointApi>;
