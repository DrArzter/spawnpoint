import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createLifecycleCoordinator, type CoordinatorInput } from "../lifecycle/coordinator.ts";
import { dynamoLifecycleStores } from "../lifecycle/dynamo-lifecycle-stores.ts";
import { createPlacementCoordinator, isPlacementInput, type PlacementInput } from "../lifecycle/placement-coordinator.ts";
import { createSessionHistoryCoordinator, isSessionHistoryInput, type SessionHistoryInput } from "../lifecycle/session-history.ts";

const tableName = process.env.LIFECYCLE_TABLE_NAME;
if (!tableName) throw new Error("LIFECYCLE_TABLE_NAME is required");

// The composition root: the client, then the stores over it.
const { store, placementStore, sessionHistoryStore } = dynamoLifecycleStores(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  tableName,
);

const lifecycle = createLifecycleCoordinator(store);
const placement = createPlacementCoordinator(placementStore);
const sessionHistory = createSessionHistoryCoordinator(sessionHistoryStore);

export const handler = async (input: CoordinatorInput | PlacementInput | SessionHistoryInput) => {
  if (isSessionHistoryInput(input)) return sessionHistory(input);
  return isPlacementInput(input) ? placement(input) : lifecycle(input);
};

export type { CoordinatorInput, PlacementInput, SessionHistoryInput };

