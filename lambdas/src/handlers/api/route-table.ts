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
import { capabilitiesForRoutes, switchedOffRoutes } from "./capabilities.ts";
import { ALL_ON, type FeatureFlags } from "./feature-flags.ts";
import { type Route } from "./routing.ts";

/** The route table as one deployment serves it, under its feature flags (ADR-0107). */
export type ApiDeployment = Readonly<{
  routes: Readonly<Record<string, Route>>;
  /** The route table's tools, read once, and the routes the flags switched off. */
  tools: () => Readonly<{ routes: Readonly<Record<string, Route>>; tools: readonly CatalogueTool[]; switchedOff: () => Promise<ReadonlySet<string>> }>;
  /** The capabilities a session advertises: the routed ones, less the assistant's switch (ADR-0094) and the flags' `off`. */
  capabilities: () => Promise<readonly string[]>;
  /** The route keys refused while the flags switch their capability off. */
  switchedOff: () => Promise<ReadonlySet<string>>;
}>;

// Capability resolution is deferred until a request, not imported back into
// session handlers. Feature modules never depend on this composition root.
// Every route says whether it is a tool (ADR-0095); whole groups that are a
// person's own sign-in, session or profile, or an agent's own way in, are not.
export function apiDeployment(flags: FeatureFlags): ApiDeployment {
  let catalogue: readonly CatalogueTool[] | null = null;
  const tools = () => {
    catalogue ??= toolCatalogue(table);
    return { routes: table, tools: catalogue, switchedOff };
  };
  const assistant = assistantRoutes(tools);
  // A capability whose routes are a group of their own is switched off whole;
  // any other loses only the route capabilities.ts names for it.
  const groups = { consoleGateway: consoleRoutes, configFiles: worldConfigRoutes, worldLog: worldLogRoutes, assistant };
  const switchedOff = async () => switchedOffRoutes((await flags.read()).off, groups);
  const capabilitiesFor = (off: ReadonlySet<string>) =>
    capabilitiesForRoutes(table, new Set([...off, ...(assistantConfig.enabled ? [] : ["assistant"])]));
  const sessionFlags = async () => {
    const values = await flags.read();
    return { capabilities: capabilitiesFor(values.off), skins: values.skins };
  };
  const table: Readonly<Record<string, Route>> = composeRoutes(
    withoutTools("signs a person in", authRoutes),
    withoutTools("a person's own session", sessionRoutes(sessionFlags)),
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
    withoutTools("the assistant's own conversation", assistant),
    invitationsRoutes,
    withoutTools("connects an agent", oauthRoutes),
    withoutTools("an agent's own way in", mcpRoutes(tools)),
  );
  return { routes: table, tools, capabilities: async () => capabilitiesFor((await flags.read()).off), switchedOff };
}

// The table with every flag on, for tests and tools that read the routes
// without a deployment; the Lambda entry builds its own under the flags.
const allOn = apiDeployment(ALL_ON);
export const routes = allOn.routes;
export const deployedTools = allOn.tools;
export const deployedCapabilities = allOn.capabilities;
