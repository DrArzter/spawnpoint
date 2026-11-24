import { worldLogKey } from "../../access/keys.ts";
import { type AccessTable } from "../../access/table.ts";
import { WORLD_LOG_RECORD_HOURS, type WorldLogRecord, type WorldLogRecords } from "../../control-plane/world-log.ts";
import { accessTable, tableName } from "./access-store.ts";

/** Log reads in the access table, one partition per world (ADR-0094). */
export function tableWorldLogRecords(table: AccessTable, name: string): WorldLogRecords {
  return {
    append: async (record) => {
      await table.put({ TableName: name, Item: {
        ...worldLogKey(record.worldId, record.id), read_id: record.id, created_at: record.at, game_id: record.gameId,
        world_id: record.worldId, host_id: record.hostId, identity_id: record.identityId,
        ttl: Math.floor(Date.parse(record.at) / 1000) + WORLD_LOG_RECORD_HOURS * 3600,
      } });
    },
    find: async (gameId, worldId, readId): Promise<WorldLogRecord | null> => {
      const { Item: item } = await table.get({ TableName: name, Key: worldLogKey(worldId, readId) });
      if (item?.game_id !== gameId || typeof item.host_id !== "string") return null;
      return {
        id: String(item.read_id), at: String(item.created_at), gameId, worldId,
        hostId: item.host_id, identityId: String(item.identity_id),
      };
    },
  };
}

export const awsWorldLogRecords: WorldLogRecords = tableWorldLogRecords(accessTable, tableName);
