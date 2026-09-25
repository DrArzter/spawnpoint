import { apiFailure, type InvitationRecipient, type InvitationSummary, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

// These invitations ask existing members to play a world. They do not grant
// project membership; access invitations live in access.ts.
export const playerInvitationsApi = {
  async loadInvitationRecipients(): Promise<InvitationRecipient[]> {
    const response = await authorizedFetch("/invitations/recipients");
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot invite players." : "Players could not be loaded.");
    const body = await response.json() as { recipients: InvitationRecipient[] };
    return body.recipients;
  },

  async loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`);
    if (!response.ok) throw await apiFailure(response, response.status === 403 ? "Your role cannot view invitation history." : "Invitation history could not be loaded.");
    const body = await response.json() as { invitations: InvitationSummary[] };
    return body.invitations;
  },

  async sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/invitations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audience, recipientIdentityIds }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      const messages: Record<string, string> = {
        forbidden: "Your role cannot invite players.",
        invalid_recipients: "One or more selected players are no longer available.",
        invitation_publish_failed: "The invitation was saved, but Telegram delivery could not be queued.",
      };
      throw new Error(messages[body.error ?? ""] ?? "The invitation could not be sent.");
    }
  },
} satisfies Partial<SpawnpointApi>;
