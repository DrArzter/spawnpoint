import { publicRoute, sessionRoute, permissionRoute, type Route } from "./routing.ts";
import { checkAccessInvitation, redeemAccessInvitation, requestAccessInvitationProof, accessInvitations, createAccessInvitation, revokeAccessInvitation } from "./access-invitations.ts";

export const accessInvitationsRoutes: Readonly<Record<string, Route>> = {
  "POST /auth/access-invitations/check": publicRoute((event) => checkAccessInvitation(event)),
  "POST /access/invitations/redeem": sessionRoute((account, event) => redeemAccessInvitation(account, event)),
  "POST /access/invitations/proof": sessionRoute((account, event) => requestAccessInvitationProof(account, event)),
  "GET /access/invitations": permissionRoute("access.invite", () => accessInvitations()),
  "POST /access/invitations": permissionRoute("access.invite", (identity, event) => createAccessInvitation(identity, event)),
  "POST /access/invitations/{invitationId}/revoke": permissionRoute("access.invite", (_identity, event) => revokeAccessInvitation(event))
};
