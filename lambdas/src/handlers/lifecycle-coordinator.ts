import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  createLifecycleCoordinator,
  type CoordinatorInput,
  type LifecycleStore,
  type VersionedLifecycle,
} from "../lifecycle/coordinator.ts";
import type { LifecycleRecord } from "../domain/lifecycle.ts";

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

export const handler = createLifecycleCoordinator(store);

export type { CoordinatorInput };

