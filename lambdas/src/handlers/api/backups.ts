import { backupInventory } from "../../control-plane/backups.ts";
import { listWorldBackups, backupArchiveUrl } from "../../control-plane/aws.ts";
import { type Identity } from "../../access/domain.ts";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { type Response, response } from "./http.ts";
import { knownWorld } from "./world-state.ts";
import { document, tableName } from "./access-store.ts";

// What a restore would have to choose between. The inventory is a listing,
// read without touching an archive; reading one is a download.
export async function backups(gameId: string, worldId: string): Promise<Response> {
  if (!await knownWorld(gameId, worldId)) return response(404, { error: "unknown_world" });
  return response(200, backupInventory(await listWorldBackups(worldId)));
}

const BACKUP_LINK_SECONDS = 300;

const DOWNLOAD_RECORD_DAYS = 365;

// A world's whole save, for whoever holds backup.download (ADR-0065). The key
// must be one of this world's archives. Who asked is recorded before the link
// is handed over, and the link lives five minutes.
export async function backupDownload(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { key?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const key = parsed.key;
  if (typeof key !== "string" || !key.startsWith(`worlds/${worldId}/archives/`) || !/^worlds\/[a-z0-9][a-z0-9-]{0,31}\/archives\/[A-Za-z0-9._-]+\.tar\.zst$/.test(key)) {
    return response(400, { error: "invalid_backup_key" });
  }
  if (!await knownWorld(gameId, worldId)) return response(404, { error: "unknown_world" });
  const link = await backupArchiveUrl(key, BACKUP_LINK_SECONDS);
  if (link === null) return response(404, { error: "unknown_backup" });
  const at = new Date().toISOString();
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `DOWNLOAD#${worldId}`, sk: `${at}#${randomUUID()}`, created_at: at,
    identity_id: identity.id, display_name: identity.displayName, game_id: gameId, world_id: worldId,
    key, size_bytes: link.sizeBytes,
    ttl: Math.floor(Date.now() / 1000) + DOWNLOAD_RECORD_DAYS * 24 * 3600,
  } }));
  return response(200, { key, url: link.url, expiresIn: BACKUP_LINK_SECONDS, sizeBytes: link.sizeBytes });
}
