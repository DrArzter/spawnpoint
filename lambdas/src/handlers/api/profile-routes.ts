import { identityRoute, type Route } from "./routing.ts";
import { me, subscriptions, updateSubscriptions, appearance, updateAppearance } from "./profile.ts";
import { linkedAccounts, linkProofAccount } from "./linked-accounts.ts";
import { proofLinkProviders, loginProviderDisabled } from "./login-providers.ts";
import { parameter, response } from "./http.ts";
import { passwordLoginEnabled } from "./auth-config.ts";
import { emailDeliveryProvider } from "./mail.ts";
import { linkPassword, changePassword } from "./passwords.ts";

export const profileRoutes: Readonly<Record<string, Route>> = {
  "GET /me": identityRoute((identity) => me(identity)),
  "GET /me/accounts": identityRoute((identity) => linkedAccounts(identity)),
  "POST /me/accounts/{provider}": identityRoute((identity, event) => {
    const provider = proofLinkProviders.get(parameter(event, "provider"));
    return provider === undefined ? response(404, { error: "not_found" }) : linkProofAccount(identity, provider, event);
  }),
  "POST /me/password": identityRoute((identity, event) => (
    passwordLoginEnabled && emailDeliveryProvider !== "none" ? linkPassword(identity, event) : loginProviderDisabled()
  )),
  "POST /me/password/change": identityRoute((identity, event) => (
    passwordLoginEnabled ? changePassword(identity, event) : loginProviderDisabled()
  )),
  "GET /me/subscriptions": identityRoute((identity) => subscriptions(identity)),
  "PUT /me/subscriptions": identityRoute((identity, event) => updateSubscriptions(identity, event.body)),
  "GET /me/appearance": identityRoute((identity) => appearance(identity)),
  "PUT /me/appearance": identityRoute((identity, event) => updateAppearance(identity, event.body))
};
