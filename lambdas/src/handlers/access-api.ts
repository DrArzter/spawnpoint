import { createDispatcher } from "./api/dispatcher.ts";
import { caller } from "./api/login-sessions.ts";
import { resolveIdentity } from "./api/identity-store.ts";
import { panelUrl, legacyPanelUrl } from "./api/origins.ts";
import { routes } from "./api/route-table.ts";

// The deployed Lambda entry stays stable. Functional modules own their routes;
// this composition root wires the one HTTP authentication/authorization gate.
export { routes, deployedCapabilities } from "./api/route-table.ts";
export { restorableRelease } from "./api/worlds.ts";

export const handler = createDispatcher(routes, {
  caller,
  resolveIdentity,
  panelOrigins: [panelUrl, legacyPanelUrl].filter(Boolean),
});
