import { permissionRoute, type Route } from "./routing.ts";
import { invitationRecipients, createInvitation, invitationHistory } from "./invitations.ts";
import { parameter } from "./http.ts";

export const invitationsRoutes: Readonly<Record<string, Route>> = {
  "GET /invitations/recipients": permissionRoute("invitation.send", (identity) => invitationRecipients(identity), {
    name: "list_invitation_recipients", title: "List invitation recipients", effect: "read",
    description: "List the people a player invitation can go to directly, with whether the Telegram bot can reach each.",
  }),
  "POST /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    createInvitation(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "invite_players", title: "Invite players", effect: "write",
    description: "Send an invitation to play a world through the Telegram bot: to everyone, or to the people named.",
    input: {
      audience: { type: "string", enum: ["broadcast", "direct"], description: "Everyone the bot can reach, or only the people named" },
      recipientIdentityIds: { type: "array", items: { type: "string", pattern: "^[0-9a-f-]{36}$" }, maxItems: 100, description: "For direct: identity ids from list_invitation_recipients" },
    },
    required: ["audience"],
  }),
  "GET /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    invitationHistory(identity, parameter(event, "gameId"), parameter(event, "worldId")), {
    name: "list_world_invitations", title: "List world invitations", effect: "read",
    description: "List the invitations sent for a world, newest first.",
  }),
};
