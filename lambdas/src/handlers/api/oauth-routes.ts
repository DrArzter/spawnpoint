import { publicRoute, identityRoute, type Route } from "./routing.ts";
import { oauthResourceMetadata, oauthServerMetadata, registerOAuthClient, startOAuthAuthorization, oauthToken, revokeOAuthToken, inspectOAuthAuthorization, completeOAuthAuthorization } from "./oauth.ts";

export const oauthRoutes: Readonly<Record<string, Route>> = {
  "GET /.well-known/oauth-protected-resource": publicRoute(() => oauthResourceMetadata()),
  "GET /.well-known/oauth-protected-resource/mcp": publicRoute(() => oauthResourceMetadata()),
  "GET /.well-known/oauth-authorization-server": publicRoute(() => oauthServerMetadata()),
  "POST /oauth/register": publicRoute((event) => registerOAuthClient(event)),
  "GET /oauth/authorize": publicRoute((event) => startOAuthAuthorization(event)),
  "POST /oauth/token": publicRoute((event) => oauthToken(event)),
  "POST /oauth/revoke": publicRoute((event) => revokeOAuthToken(event)),
  "POST /oauth/authorize/inspect": identityRoute((_identity, event) => inspectOAuthAuthorization(event)),
  "POST /oauth/authorize": identityRoute((identity, event) => completeOAuthAuthorization(identity, event))
};
