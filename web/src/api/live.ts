import type { SpawnpointApi } from "./contract";
import { accessApi } from "./live/access";
import { authApi } from "./live/auth";
import { backupsApi } from "./live/backups";
import { metricsApi } from "./live/metrics";
import { playerInvitationsApi } from "./live/player-invitations";
import { preferencesApi } from "./live/preferences";
import { worldsApi } from "./live/worlds";

export { googleOidcClientId, liveAuthConfigured, telegramOidcClientId } from "./live/auth";

// The app consumes one contract. Each feature client owns its own endpoint
// mapping; this file only assembles them for the live transport.
export const liveApi: SpawnpointApi = {
  ...authApi,
  ...accessApi,
  ...worldsApi,
  ...backupsApi,
  ...metricsApi,
  ...playerInvitationsApi,
  ...preferencesApi,
};
