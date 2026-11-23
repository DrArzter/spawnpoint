import type { InvitationRecipient, InvitationSummary, SpawnpointApi } from "../contract";
import { request } from "./request";

const worldPath = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}`;

// These invitations ask existing members to play a world. They do not grant
// project membership; access invitations live in access.ts.
export const playerInvitationsApi = {
  async loadInvitationRecipients(): Promise<InvitationRecipient[]> {
    const body = await request<{ recipients: InvitationRecipient[] }>("/invitations/recipients", {
      failure: "Players could not be loaded.", refusals: { forbidden: "Your role cannot invite players." },
    });
    return body.recipients;
  },

  async loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
    const body = await request<{ invitations: InvitationSummary[] }>(`${worldPath(gameId, worldId)}/invitations`, {
      failure: "Invitation history could not be loaded.", refusals: { forbidden: "Your role cannot view invitation history." },
    });
    return body.invitations;
  },

  async sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
    await request<unknown>(`${worldPath(gameId, worldId)}/invitations`, {
      method: "POST", body: { audience, recipientIdentityIds },
      failure: "The invitation could not be sent.",
      refusals: { forbidden: "Your role cannot invite players." },
    });
  },
} satisfies Partial<SpawnpointApi>;
