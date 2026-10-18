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
  backupDownloads: "POST /games/{gameId}/worlds/{worldId}/backups/download",
  whitelist: "PUT /games/{gameId}/worlds/{worldId}/whitelist",
  releaseBuilds: "POST /games/{gameId}/presets/{presetId}/builds",
};

export function capabilitiesForRoutes(routes: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(capabilityRoutes)
    .filter(([, routeKey]) => Object.hasOwn(routes, routeKey))
    .map(([name]) => name);
}
