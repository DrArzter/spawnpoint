import { notATool, publicRoute, sessionRoute, permissionRoute, type Route } from "./routing.ts";
import { checkAccessInvitation, redeemAccessInvitation, requestAccessInvitationProof, accessInvitations, createAccessInvitation, revokeAccessInvitation } from "./access-invitations.ts";

export const accessInvitationsRoutes: Readonly<Record<string, Route>> = {
  // An invited person's own steps, before they have access.
  "POST /auth/access-invitations/check": notATool("an invited person's own step", publicRoute((event) => checkAccessInvitation(event))),
  "POST /access/invitations/redeem": notATool("an invited person's own step", sessionRoute((account, event) => redeemAccessInvitation(account, event))),
  "POST /access/invitations/proof": notATool("an invited person's own step", sessionRoute((account, event) => requestAccessInvitationProof(account, event))),
  "GET /access/invitations": permissionRoute("access.invite", () => accessInvitations(), {
    name: "list_access_invitations", title: "List access invitations", effect: "read",
    description: "List the invitations to the panel that are still open.",
  }),
  "POST /access/invitations": permissionRoute("access.invite", (identity, event) => createAccessInvitation(identity, event), {
    name: "create_access_invitation", title: "Invite a person to the panel", effect: "write",
    description: "Create an invitation link to the panel, and send it by email when an address is given.",
    input: { email: { type: "string", description: "Where to send the link; left out, the link is only returned" } },
  }),
  "POST /access/invitations/{invitationId}/revoke": permissionRoute("access.invite", (_identity, event) => revokeAccessInvitation(event), {
    name: "revoke_access_invitation", title: "Revoke access invitation", effect: "write",
    description: "Revoke an open invitation to the panel, so its link no longer works.",
  })
};
