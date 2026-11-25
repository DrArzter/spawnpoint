import { authRoutes } from "./auth-routes.ts";
import { sessionRoutes } from "./session-routes.ts";
import { profileRoutes } from "./profile-routes.ts";
import { accessRoutes } from "./access-routes.ts";
import { accessInvitationsRoutes } from "./access-invitations-routes.ts";
import { controlPlaneRoutes } from "./control-plane-routes.ts";
import { worldsRoutes } from "./worlds-routes.ts";
import { operationsRoutes } from "./operations-routes.ts";
import { metricsRoutes } from "./metrics-routes.ts";
import { releasesRoutes } from "./releases-routes.ts";
import { backupsRoutes } from "./backups-routes.ts";
import { promotionRoutes } from "./promotion-routes.ts";
import { hostsRoutes } from "./hosts-routes.ts";
import { consoleRoutes } from "./console-routes.ts";
import { worldConfigRoutes } from "./world-config-routes.ts";
import { worldLogRoutes } from "./world-log-routes.ts";
import { assistantRoutes } from "./assistant-routes.ts";
import { assistantConfig } from "./assistant-wiring.ts";
import { invitationsRoutes } from "./invitations-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { mcpRoutes } from "./mcp-routes.ts";
import { composeRoutes, withoutTools } from "./routing.ts";
import { type CatalogueTool, toolCatalogue } from "./tool-catalogue.ts";
import { capabilitiesForRoutes } from "./capabilities.ts";

// Capability resolution is deferred until a request, not imported back into
// session handlers. Feature modules never depend on this composition root.
// Every route says whether it is a tool (ADR-0095); whole groups that are a
// person's own sign-in, session or profile, or an agent's own way in, are not.
export const routes = composeRoutes(
  withoutTools("signs a person in", authRoutes),
  withoutTools("a person's own session", sessionRoutes(deployedCapabilities)),
  withoutTools("a person's own profile", profileRoutes),
  accessRoutes,
  accessInvitationsRoutes,
  controlPlaneRoutes,
  worldsRoutes,
  operationsRoutes,
  metricsRoutes,
  releasesRoutes,
  backupsRoutes,
  promotionRoutes,
  hostsRoutes,
  consoleRoutes,
  worldConfigRoutes,
  worldLogRoutes,
  withoutTools("the assistant's own conversation", assistantRoutes(deployedTools)),
  invitationsRoutes,
  withoutTools("connects an agent", oauthRoutes),
  withoutTools("an agent's own way in", mcpRoutes(deployedTools)),
);

let catalogue: readonly CatalogueTool[] | null = null;

/** The route table's tools, read once per container. */
export function deployedTools(): Readonly<{ routes: typeof routes; tools: readonly CatalogueTool[] }> {
  catalogue ??= toolCatalogue(routes);
  return { routes, tools: catalogue };
}

export function deployedCapabilities(): readonly string[] {
  return capabilitiesForRoutes(routes, new Set(assistantConfig.enabled ? [] : ["assistant"]));
}
