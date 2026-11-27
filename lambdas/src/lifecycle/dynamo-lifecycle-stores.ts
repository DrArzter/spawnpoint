import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { LifecycleStore, VersionedLifecycle } from "./coordinator.ts";
import type { PlacementStore, VersionedHost } from "./placement-coordinator.ts";
import type { GameProofStore, SessionHistoryStore } from "./session-history.ts";
import { provenGameKey } from "../domain/proven-games.ts";
import type { LifecycleRecord } from "../domain/lifecycle.ts";
import type { HostRecord } from "../domain/placement.ts";
import type { SessionHost } from "../domain/session-history.ts";

/**
 * The coordinator's stores over the lifecycle table: the lifecycle record per
 * key, the host records ("host#"), the session history ("sessions#") and each
 * game's proof ("proven#", ADR-0109). Each write is conditional.
 */
export function dynamoLifecycleStores(documentClient: DynamoDBDocumentClient, tableName: string): Readonly<{
  store: LifecycleStore;
  placementStore: PlacementStore;
  sessionHistoryStore: SessionHistoryStore;
  gameProofStore: GameProofStore;
}> {
  function isConditionalFailure(error: unknown): boolean {
    return error instanceof Error && error.name === "ConditionalCheckFailedException";
  }

  const store: LifecycleStore = {
    async read(serverId: string): Promise<VersionedLifecycle | null> {
      const response = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { server_id: serverId },
          ConsistentRead: true,
        }),
      );
      if (!response.Item) return null;
      return {
        revision: response.Item.revision as number,
        record: response.Item.lifecycle as LifecycleRecord,
      };
    },

    async create(serverId: string, record: LifecycleRecord): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { server_id: serverId, revision: 1, lifecycle: record },
            ConditionExpression: "attribute_not_exists(server_id)",
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async compareAndSet(
      serverId: string,
      expectedRevision: number,
      record: LifecycleRecord,
    ): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              server_id: serverId,
              revision: expectedRevision + 1,
              lifecycle: record,
            },
            ConditionExpression: "revision = :expected_revision",
            ExpressionAttributeValues: { ":expected_revision": expectedRevision },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
  };

  // Host records (ADR-0054) share the table under a prefixed key, so one
  // coordinator and one set of permissions serve both kinds of record. The
  // fleet is read with a scan today; at a fleet where that shows, the prefix
  // becomes an index, and nothing above this store changes.
  const HOST_KEY_PREFIX = "host#";

  const placementStore: PlacementStore = {
    async readHost(hostId: string): Promise<VersionedHost | null> {
      const response = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: { server_id: `${HOST_KEY_PREFIX}${hostId}` }, ConsistentRead: true }),
      );
      if (!response.Item) return null;
      return { revision: response.Item.revision as number, record: response.Item.host as HostRecord };
    },

    async listHosts(): Promise<readonly VersionedHost[]> {
      const hosts: VersionedHost[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const response = await documentClient.send( // NOSONAR paginated: the next token comes from the previous page
          new ScanCommand({
            TableName: tableName,
            ConsistentRead: true,
            FilterExpression: "begins_with(server_id, :prefix)",
            ExpressionAttributeValues: { ":prefix": HOST_KEY_PREFIX },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        );
        for (const item of response.Items ?? []) {
          hosts.push({ revision: item.revision as number, record: item.host as HostRecord });
        }
        startKey = response.LastEvaluatedKey;
      } while (startKey);
      return hosts;
    },

    async createHost(record: HostRecord): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { server_id: `${HOST_KEY_PREFIX}${record.hostId}`, revision: 1, host: record },
            ConditionExpression: "attribute_not_exists(server_id)",
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async compareAndSetHost(hostId: string, expectedRevision: number, record: HostRecord): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { server_id: `${HOST_KEY_PREFIX}${hostId}`, revision: expectedRevision + 1, host: record },
            ConditionExpression: "revision = :expected_revision",
            ExpressionAttributeValues: { ":expected_revision": expectedRevision },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
  };

  // Which host each session of a world ran on (ADR-0015): one bounded item per
  // world under its own prefix, so the same table and permissions serve it. The
  // access API reads it with GetItem.
  const SESSION_HISTORY_KEY_PREFIX = "sessions#";

  const sessionHistoryStore: SessionHistoryStore = {
    async read(worldId: string) {
      const response = await documentClient.send(
        new GetCommand({ TableName: tableName, Key: { server_id: `${SESSION_HISTORY_KEY_PREFIX}${worldId}` }, ConsistentRead: true }),
      );
      if (!response.Item) return null;
      return { revision: response.Item.revision as number, entries: response.Item.entries as SessionHost[] };
    },

    async create(worldId: string, entries: readonly SessionHost[]): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { server_id: `${SESSION_HISTORY_KEY_PREFIX}${worldId}`, revision: 1, entries },
            ConditionExpression: "attribute_not_exists(server_id)",
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async compareAndSet(worldId: string, expectedRevision: number, entries: readonly SessionHost[]): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { server_id: `${SESSION_HISTORY_KEY_PREFIX}${worldId}`, revision: expectedRevision + 1, entries },
            ConditionExpression: "revision = :expected_revision",
            ExpressionAttributeValues: { ":expected_revision": expectedRevision },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },
  };

  // Written once per game: the first ready session is the one kept.
  const gameProofStore: GameProofStore = {
    async record(proof) {
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: { server_id: provenGameKey(proof.gameId), game_id: proof.gameId, world_id: proof.worldId, first_ready_at: proof.firstReadyAt },
          ConditionExpression: "attribute_not_exists(server_id)",
        }));
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    },
  };

  return { store, placementStore, sessionHistoryStore, gameProofStore };
}
