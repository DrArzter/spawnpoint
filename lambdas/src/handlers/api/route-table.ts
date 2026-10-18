import { authRoutes } from "./auth-routes.ts";
import { sessionRoutes } from "./session-routes.ts";
import { profileRoutes } from "./profile-routes.ts";
import { accessRoutes } from "./access-routes.ts";
import { accessInvitationsRoutes } from "./access-invitations-routes.ts";
import { controlPlaneRoutes } from "./control-plane-routes.ts";
import { worldsRoutes } from "./worlds-routes.ts";
import { metricsRoutes } from "./metrics-routes.ts";
import { releasesRoutes } from "./releases-routes.ts";
import { backupsRoutes } from "./backups-routes.ts";
import { consoleRoutes } from "./console-routes.ts";
import { invitationsRoutes } from "./invitations-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { mcpRoutes } from "./mcp-routes.ts";
import { composeRoutes } from "./routing.ts";
import { capabilitiesForRoutes } from "./capabilities.ts";

// Capability resolution is deferred until a request, not imported back into
// session handlers. Feature modules never depend on this composition root.
export const routes = composeRoutes(
  authRoutes,
  sessionRoutes(deployedCapabilities),
  profileRoutes,
  accessRoutes,
  accessInvitationsRoutes,
  controlPlaneRoutes,
  worldsRoutes,
  metricsRoutes,
  releasesRoutes,
  backupsRoutes,
  consoleRoutes,
  invitationsRoutes,
  oauthRoutes,
  mcpRoutes,
);

export function deployedCapabilities(): readonly string[] {
  return capabilitiesForRoutes(routes);
}
