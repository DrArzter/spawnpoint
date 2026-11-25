import type { BackupInventory, FileLink, SpawnpointApi } from "../contract";
import { request } from "./request";
import { t } from "../../i18n";

const worldPath = (gameId: string, worldId: string) => `/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}`;

export const backupsApi = {
  async loadBackups(gameId: string, worldId: string): Promise<BackupInventory> {
    const body = await request<Partial<BackupInventory>>(`${worldPath(gameId, worldId)}/backups`, {
      failure: t("backups.backupInventoryUnavailable"),
      refusals: { forbidden: t("backups.roleCannotReadBackups") },
      valid: (inventory) => inventory.entries !== undefined,
    });
    return { entries: body.entries ?? [], unverified: body.unverified ?? 0, truncated: body.truncated ?? false };
  },

  async requestBackupDownload(gameId: string, worldId: string, key: string): Promise<FileLink> {
    const body = await request<{ url?: string; expiresIn?: number }>(`${worldPath(gameId, worldId)}/backups/download`, {
      method: "POST", body: { key },
      failure: t("common.downloadLinkCouldNot"),
      refusals: { forbidden: t("backups.roleCannotDownloadBackups") },
      valid: (link) => link.url !== undefined,
    });
    return { url: body.url ?? "", expiresIn: body.expiresIn ?? 0 };
  },
} satisfies Partial<SpawnpointApi>;
