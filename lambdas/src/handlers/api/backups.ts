import type { BackupInventory } from "../../../../contract/backups.ts";
import { type Identity } from "../../access/domain.ts";
import { withBackupReleases } from "../../control-plane/backup-release.ts";
import { backupInventory, type BackupArchives, type BackupDownloads } from "../../control-plane/backups.ts";
import { type WorldRecord } from "../../control-plane/world-registry.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";

const BACKUP_LINK_SECONDS = 300;

const BACKUP_KEY = /^worlds\/[a-z0-9][a-z0-9-]{0,31}\/archives\/[A-Za-z0-9._-]+\.tar\.zst$/;

/** What the backups need, injected so that they depend on no cloud API. */
export type BackupsDependencies = Readonly<{
  knownWorld: (gameId: string, worldId: string) => Promise<boolean>;
  readWorldRecord: (worldId: string) => Promise<WorldRecord | null>;
  archives: BackupArchives;
  downloads: BackupDownloads;
  now: () => Date;
}>;

export type BackupsFeature = Readonly<{
  backups: (gameId: string, worldId: string) => Promise<Response>;
  backupDownload: (identity: Identity, gameId: string, worldId: string, body: string | undefined) => Promise<Response>;
}>;

export function backupsFeature({ knownWorld, readWorldRecord, archives, downloads, now }: BackupsDependencies): BackupsFeature {
  return {
    // What a restore would have to choose between. The inventory is a listing,
    // read without touching an archive; reading one is a download. Each entry
    // names the release a restore would use: one HEAD per listed archive.
    async backups(gameId, worldId) {
      if (!await knownWorld(gameId, worldId)) return errorResponse(404, "unknown_world");
      const [inventory, record] = await Promise.all([archives.list(worldId).then((objects) => backupInventory(objects)), readWorldRecord(worldId)]);
      const body: BackupInventory = { ...inventory, entries: await withBackupReleases(record, inventory.entries, archives.releaseSources()) };
      return response(200, body);
    },
    // A world's whole save, for whoever holds backup.download (ADR-0065). The key
    // must be one of this world's archives. Who asked is recorded before the link
    // is handed over, and the link lives five minutes.
    async backupDownload(identity, gameId, worldId, body) {
      const key = parseJsonObject({ body }).key;
      if (typeof key !== "string" || !key.startsWith(`worlds/${worldId}/archives/`) || !BACKUP_KEY.test(key)) {
        return errorResponse(400, "invalid_backup_key");
      }
      if (!await knownWorld(gameId, worldId)) return errorResponse(404, "unknown_world");
      const link = await archives.link(key, BACKUP_LINK_SECONDS);
      if (link === null) return errorResponse(404, "unknown_backup");
      await downloads.record({
        at: now().toISOString(), identityId: identity.id, displayName: identity.displayName, gameId, worldId, key, sizeBytes: link.sizeBytes,
      });
      return response(200, { key, url: link.url, expiresIn: BACKUP_LINK_SECONDS, sizeBytes: link.sizeBytes });
    },
  };
}
