import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  createLifecycleCoordinator,
  type CoordinatorInput,
  type LifecycleStore,
  type VersionedLifecycle,
} from "../lifecycle/coordinator.ts";
import {
  createPlacementCoordinator,
  isPlacementInput,
  type PlacementInput,
  type PlacementStore,
  type VersionedHost,
} from "../lifecycle/placement-coordinator.ts";
import type { LifecycleRecord } from "../domain/lifecycle.ts";
import type { HostRecord } from "../domain/placement.ts";

const tableName = process.env.LIFECYCLE_TABLE_NAME;
if (!tableName) throw new Error("LIFECYCLE_TABLE_NAME is required");

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

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
      const response = await documentClient.send(
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

const lifecycle = createLifecycleCoordinator(store);
const placement = createPlacementCoordinator(placementStore);

export const handler = async (input: CoordinatorInput | PlacementInput) =>
  isPlacementInput(input) ? placement(input) : lifecycle(input as CoordinatorInput);

export type { CoordinatorInput, PlacementInput };

