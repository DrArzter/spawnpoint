// Capability names are the panel contract; route keys are deployment truth.
// Tests compare these references with API Gateway's Terraform routes.
const capabilityRoutes: Readonly<Record<string, string>> = {
  releaseManifest: "GET /games/{gameId}/presets/{presetId}/releases/{version}",
  hostMetrics: "GET /hosts/{instanceId}/metrics",
  worldMetrics: "GET /games/{gameId}/worlds/{worldId}/metrics",
  invitations: "POST /games/{gameId}/worlds/{worldId}/invitations",
  clientPacks: "GET /games/{gameId}/worlds/{worldId}/pack",
  backups: "GET /games/{gameId}/worlds/{worldId}/backups",
  worldLifecycle: "POST /games/{gameId}/worlds/{worldId}/wipe",
  accessManagement: "GET /access/identities",
  accessInvitations: "GET /access/invitations",
  consoleGateway: "POST /games/{gameId}/worlds/{worldId}/console",
  gameSettings: "PUT /games/{gameId}/worlds/{worldId}/game-settings",
  releaseFiles: "GET /games/{gameId}/presets/{presetId}/releases/{version}/mods/{sha256}",
  releaseDiff: "GET /games/{gameId}/presets/{presetId}/releases/{version}/diff",
  backupDownloads: "POST /games/{gameId}/worlds/{worldId}/backups/download",
  whitelist: "PUT /games/{gameId}/worlds/{worldId}/whitelist",
  configFiles: "PUT /games/{gameId}/worlds/{worldId}/config-files",
  worldLog: "POST /games/{gameId}/worlds/{worldId}/log",
  assistant: "POST /games/{gameId}/worlds/{worldId}/assistant",
  releaseBuilds: "POST /games/{gameId}/presets/{presetId}/builds",
  releasePromotion: "POST /games/{gameId}/worlds/{worldId}/promote",
  operationProgress: "GET /games/{gameId}/worlds/{worldId}/operations/{operationId}",
  hostDeletion: "DELETE /hosts/{instanceId}",
};

/** The capabilities whose routes exist, less those the deployment switched off (the assistant, ADR-0094). */
export function capabilitiesForRoutes(routes: Readonly<Record<string, unknown>>, switchedOff: ReadonlySet<string> = new Set()): readonly string[] {
  return Object.entries(capabilityRoutes)
    .filter(([name, routeKey]) => Object.hasOwn(routes, routeKey) && !switchedOff.has(name))
    .map(([name]) => name);
}
