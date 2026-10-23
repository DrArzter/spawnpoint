import { permissionRoute, type Route } from "./routing.ts";
import { invitationRecipients, createInvitation, invitationHistory } from "./invitations.ts";
import { parameter } from "./http.ts";

export const invitationsRoutes: Readonly<Record<string, Route>> = {
  "GET /invitations/recipients": permissionRoute("invitation.send", (identity) => invitationRecipients(identity)),
  "POST /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    createInvitation(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    invitationHistory(identity, parameter(event, "gameId"), parameter(event, "worldId")))
};
