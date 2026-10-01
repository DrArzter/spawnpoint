import { apiFailure, type BackupInventory, type SpawnpointApi } from "../contract";
import { authorizedFetch } from "./transport";

export const backupsApi = {
  async loadBackups(gameId: string, worldId: string): Promise<BackupInventory> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups`);
    const body = await response.json() as { error?: string } & Partial<BackupInventory>;
    if (!response.ok || body.entries === undefined) {
      // The body is already read; classify with it instead of reading twice.
      throw await apiFailure(response, body.error === "forbidden" ? "Your role cannot read backups." : "The backup inventory is unavailable.", body);
    }
    return { entries: body.entries, unverified: body.unverified ?? 0, truncated: body.truncated ?? false };
  },
} satisfies Partial<SpawnpointApi>;
