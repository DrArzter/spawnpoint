import { type DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import { downloadPartition, downloadSortKey } from "../../access/keys.ts";
import type { BackupDownloads } from "../../control-plane/backups.ts";
import { document, tableName } from "./access-store.ts";

const DOWNLOAD_RECORD_DAYS = 365;

/** Who downloaded which archive, in the access table, kept for a year (ADR-0065). */
export function dynamoBackupDownloads(client: DynamoDBDocumentClient, table: string): BackupDownloads {
  return {
    record: async (download) => {
      await client.send(new PutCommand({ TableName: table, Item: {
        pk: downloadPartition(download.worldId), sk: downloadSortKey(download.at, randomUUID()), created_at: download.at,
        identity_id: download.identityId, display_name: download.displayName, game_id: download.gameId, world_id: download.worldId,
        key: download.key, size_bytes: download.sizeBytes,
        ttl: Math.floor(Date.parse(download.at) / 1000) + DOWNLOAD_RECORD_DAYS * 24 * 3600,
      } }));
    },
  };
}

export const awsBackupDownloads: BackupDownloads = dynamoBackupDownloads(document, tableName);
