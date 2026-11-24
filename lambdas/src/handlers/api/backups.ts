import { backupInventory } from "../../control-plane/backups.ts";
import { withBackupReleases } from "../../control-plane/backup-release.ts";
import { listWorldBackups, backupArchiveUrl, backupReleaseSources, readWorldRecord } from "../../control-plane/aws.ts";
import { type Identity } from "../../access/domain.ts";
import { downloadPartition } from "../../access/keys.ts";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { type Response, response, parseJsonObject } from "./http.ts";
import { knownWorld } from "./world-state.ts";
import type { BackupInventory } from "../../../../contract/backups.ts";
import { document, tableName } from "./access-store.ts";

// What a restore would have to choose between. The inventory is a listing,
// read without touching an archive; reading one is a download. Each entry
// names the release a restore would use: one HEAD per listed archive.
export async function backups(gameId: string, worldId: string): Promise<Response> {
  if (!await knownWorld(gameId, worldId)) return response(404, { error: "unknown_world" });
  const [inventory, record] = await Promise.all([listWorldBackups(worldId).then((objects) => backupInventory(objects)), readWorldRecord(worldId)]);
  const body: BackupInventory = { ...inventory, entries: await withBackupReleases(record, inventory.entries, backupReleaseSources()) };
  return response(200, body);
}

const BACKUP_LINK_SECONDS = 300;

const DOWNLOAD_RECORD_DAYS = 365;

// A world's whole save, for whoever holds backup.download (ADR-0065). The key
// must be one of this world's archives. Who asked is recorded before the link
// is handed over, and the link lives five minutes.
export async function backupDownload(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const key = parsed.key;
  if (typeof key !== "string" || !key.startsWith(`worlds/${worldId}/archives/`) || !/^worlds\/[a-z0-9][a-z0-9-]{0,31}\/archives\/[A-Za-z0-9._-]+\.tar\.zst$/.test(key)) {
    return response(400, { error: "invalid_backup_key" });
  }
  if (!await knownWorld(gameId, worldId)) return response(404, { error: "unknown_world" });
  const link = await backupArchiveUrl(key, BACKUP_LINK_SECONDS);
  if (link === null) return response(404, { error: "unknown_backup" });
  const at = new Date().toISOString();
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: downloadPartition(worldId), sk: `${at}#${randomUUID()}`, created_at: at,
    identity_id: identity.id, display_name: identity.displayName, game_id: gameId, world_id: worldId,
    key, size_bytes: link.sizeBytes,
    ttl: Math.floor(Date.now() / 1000) + DOWNLOAD_RECORD_DAYS * 24 * 3600,
  } }));
  return response(200, { key, url: link.url, expiresIn: BACKUP_LINK_SECONDS, sizeBytes: link.sizeBytes });
}
