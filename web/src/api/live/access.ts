import { apiFailure, type AccessCandidate, type AccessIdentity, type AccessInvitation, type AccessRole, type SpawnpointApi } from "../contract";
import { authorizedFetch, publicPost } from "./transport";

// Project membership and roles. Player-to-player invitations belong to the
// game client, not this access-invitation flow.
export const accessApi = {
  async requestAccess(): Promise<void> {
    const response = await authorizedFetch("/access/request", { method: "POST" });
    if (!response.ok) throw await apiFailure(response, "The access request could not be sent.");
  },

  async checkAccessInvitation(token: string): Promise<{ valid: boolean; email: string | null }> {
    const response = await publicPost("/auth/access-invitations/check", { token });
    if (!response.ok) throw await apiFailure(response, "This invitation could not be checked.");
    const body = await response.json() as { valid?: unknown; email?: unknown };
    return { valid: body.valid === true, email: typeof body.email === "string" ? body.email : null };
  },

  async redeemAccessInvitation(token: string, proof?: string): Promise<void> {
    const response = await authorizedFetch("/access/invitations/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...(proof ? { proof } : {}) }),
    });
    if (!response.ok) throw await apiFailure(response, response.status === 409 ? "This invitation is no longer available, or this account already has access." : "This invitation could not be accepted.");
  },

  async requestAccessInvitationProof(token: string): Promise<void> {
    const response = await authorizedFetch("/access/invitations/proof", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
    });
    if (!response.ok) throw await apiFailure(response, response.status === 429 ? "A confirmation email was just sent. Wait a minute before trying again." : "The confirmation email could not be sent.");
  },

  async loadAccessInvitations(): Promise<AccessInvitation[]> {
    const response = await authorizedFetch("/access/invitations");
    if (!response.ok) throw await apiFailure(response, "Invitations could not be loaded.");
    const body = await response.json() as { invitations: AccessInvitation[] };
    return body.invitations;
  },

  async createAccessInvitation(email: string | null) {
    const response = await authorizedFetch("/access/invitations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(email === null ? {} : { email }),
    });
    if (!response.ok) throw await apiFailure(response, "An invitation could not be created.");
    return response.json() as ReturnType<SpawnpointApi["createAccessInvitation"]>;
  },

  async revokeAccessInvitation(id: string): Promise<void> {
    const response = await authorizedFetch(`/access/invitations/${encodeURIComponent(id)}/revoke`, { method: "POST" });
    if (!response.ok) throw await apiFailure(response, "This invitation could not be revoked.");
  },

  async loadAccessCandidates(): Promise<AccessCandidate[]> {
    const response = await authorizedFetch("/access/candidates");
    if (!response.ok) throw await apiFailure(response, "Access requests could not be loaded.");
    const body = await response.json() as { candidates: AccessCandidate[] };
    return body.candidates;
  },

  async approveAccessCandidate(platform: string, platformUserId: string, roleId: string) {
    const response = await authorizedFetch(`/access/candidates/${encodeURIComponent(platform)}/${encodeURIComponent(platformUserId)}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId }),
    });
    if (!response.ok) throw await apiFailure(response, "This account could not be approved.");
    const body = await response.json() as { identity: { id: string; displayName: string; roleId: string } };
    return body.identity;
  },

  async dismissAccessCandidate(platform: string, platformUserId: string): Promise<void> {
    const response = await authorizedFetch(`/access/candidates/${encodeURIComponent(platform)}/${encodeURIComponent(platformUserId)}/dismiss`, { method: "POST" });
    if (!response.ok) throw await apiFailure(response, "This account could not be dismissed.");
  },

  async loadAccessIdentities(): Promise<AccessIdentity[]> {
    const response = await authorizedFetch("/access/identities");
    if (!response.ok) throw await apiFailure(response, "Users could not be loaded.");
    const body = await response.json() as { identities: AccessIdentity[] };
    return body.identities;
  },

  async loadAccessRoles(): Promise<AccessRole[]> {
    const response = await authorizedFetch("/access/roles");
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot view access roles." : "Roles could not be loaded.");
    const body = await response.json() as { roles: AccessRole[] };
    return body.roles;
  },

  async updateIdentityRole(identityId: string, roleId: string): Promise<void> {
    const response = await authorizedFetch(`/access/identities/${identityId}/role`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId }),
    });
    if (!response.ok) throw await apiFailure(response, response.status === 409 ? "You cannot change your own Owner role." : "The role could not be changed.");
  },
} satisfies Partial<SpawnpointApi>;
