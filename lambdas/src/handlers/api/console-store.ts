import { type DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { consolePartition, consoleSortKey } from "../../access/keys.ts";
import { CONSOLE_RECORD_DAYS, consoleEntryFromItem, type ConsoleRecords } from "../../control-plane/console.ts";
import { document, tableName } from "./access-store.ts";
import { isConditionFailure } from "./conditions.ts";

/** The console's commands in the access table, one partition per world (ADR-0063). */
export function dynamoConsoleRecords(client: DynamoDBDocumentClient, table: string): ConsoleRecords {
  return {
    append: async ({ entry, gameId, sessionId, hostId, agentClientId }) => {
      await client.send(new PutCommand({ TableName: table, Item: {
        pk: consolePartition(entry.worldId), sk: consoleSortKey(entry.at, entry.id), command_id: entry.id, created_at: entry.at,
        identity_id: entry.identityId, display_name: entry.displayName, game_id: gameId, world_id: entry.worldId,
        session_id: sessionId, host_id: hostId, command: entry.command, status: entry.status,
        ...(agentClientId === null || entry.agent === null ? {} : { agent_client_id: agentClientId, agent_name: entry.agent }),
        ttl: Math.floor(Date.parse(entry.at) / 1000) + CONSOLE_RECORD_DAYS * 24 * 3600,
      } }));
    },
    recent: async (gameId, worldId, limit) => {
      const page = await client.send(new QueryCommand({
        TableName: table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": consolePartition(worldId) },
        ScanIndexForward: false, Limit: limit,
      }));
      // A deleted person's records keep their id and lose their name (ADR-0071).
      return (page.Items ?? [])
        .filter((item) => item.game_id === gameId)
        .map((item) => ({ entry: consoleEntryFromItem(item), hostId: typeof item.host_id === "string" ? item.host_id : null }));
    },
    settle: async (entry, result) => {
      try {
        await client.send(new UpdateCommand({
          TableName: table, Key: { pk: consolePartition(entry.worldId), sk: consoleSortKey(entry.at, entry.id) },
          UpdateExpression: "SET #status = :status, #output = :output, completed_at = :now",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status", "#output": "output" },
          ExpressionAttributeValues: { ":status": result.status, ":output": result.output, ":now": new Date().toISOString(), ":pending": "pending" },
        }));
      } catch (error) {
        // Another reader settled it first; its answer is the same.
        if (!isConditionFailure(error)) throw error;
      }
    },
  };
}

export const awsConsoleRecords: ConsoleRecords = dynamoConsoleRecords(document, tableName);
