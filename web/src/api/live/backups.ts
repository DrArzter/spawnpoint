import { apiFailure, type BackupInventory, type FileLink, type SpawnpointApi } from "../contract";
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

  async requestBackupDownload(gameId: string, worldId: string, key: string): Promise<FileLink> {
    const response = await authorizedFetch(`/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/backups/download`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; url?: string; expiresIn?: number };
    if (!response.ok || body.url === undefined) {
      const messages: Record<string, string> = {
        forbidden: "Your role cannot download backups.",
        unknown_backup: "This backup is no longer in the store. Refresh the list.",
      };
      throw new Error(messages[body.error ?? ""] ?? "The download link could not be created.");
    }
    return { url: body.url, expiresIn: body.expiresIn ?? 0 };
  },
} satisfies Partial<SpawnpointApi>;
