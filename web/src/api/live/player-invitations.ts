import type { InvitationRecipient, InvitationSummary, SpawnpointApi } from "../contract";
import { request } from "./request";
import { t } from "../../i18n";

const worldPath = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}`;

// These invitations ask existing members to play a world. They do not grant
// project membership; access invitations live in access.ts.
export const playerInvitationsApi = {
  async loadInvitationRecipients(): Promise<InvitationRecipient[]> {
    const body = await request<{ recipients: InvitationRecipient[] }>("/invitations/recipients", {
      failure: t("world.playersCouldNotLoaded"), refusals: { forbidden: t("world.roleCannotInvitePlayers") },
    });
    return body.recipients;
  },

  async loadInvitationHistory(gameId: string, worldId: string): Promise<InvitationSummary[]> {
    const body = await request<{ invitations: InvitationSummary[] }>(`${worldPath(gameId, worldId)}/invitations`, {
      failure: t("world.invitationHistoryCouldNot"), refusals: { forbidden: t("world.roleCannotViewInvitation") },
    });
    return body.invitations;
  },

  async sendInvitation(gameId: string, worldId: string, audience: "broadcast" | "direct", recipientIdentityIds: readonly string[]): Promise<void> {
    await request<unknown>(`${worldPath(gameId, worldId)}/invitations`, {
      method: "POST", body: { audience, recipientIdentityIds },
      failure: t("common.invitationCouldNotSent"),
      refusals: { forbidden: t("world.roleCannotInvitePlayers") },
    });
  },
} satisfies Partial<SpawnpointApi>;
