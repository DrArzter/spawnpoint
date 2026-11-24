import type { SpawnpointApi } from "./contract";
import { accessApi } from "./live/access";
import { authApi } from "./live/auth";
import { backupsApi } from "./live/backups";
import { metricsApi } from "./live/metrics";
import { operationsApi } from "./live/operations";
import { consoleApi } from "./live/console";
import { playerInvitationsApi } from "./live/player-invitations";
import { preferencesApi } from "./live/preferences";
import { worldsApi } from "./live/worlds";
import { assistantApi } from "./live/assistant";

export { googleOidcClientId, liveAuthConfigured, telegramOidcClientId } from "./live/auth";

// The app consumes one contract. Each feature client owns its own endpoint
// mapping; this file only assembles them for the live transport.
export const liveApi: SpawnpointApi = {
  ...authApi,
  ...accessApi,
  ...worldsApi,
  ...backupsApi,
  ...metricsApi,
  ...operationsApi,
  ...consoleApi,
  ...playerInvitationsApi,
  ...preferencesApi,
  ...assistantApi,
};
