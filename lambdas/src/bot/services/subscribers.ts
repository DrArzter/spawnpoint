import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { NotificationSubscriptionKey } from "../../domain/notifications.ts";
import type { InvitationDeliveryStatus } from "../../domain/invitations.ts";

type Item = Record<string, unknown>;
type Key = Record<string, unknown>;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
};

let document: DynamoDBDocumentClient | undefined;
function database(): DynamoDBDocumentClient {
  document ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: requiredEnv("AWS_REGION") }));
  return document;
}

export function subscribedIdentityIds(items: readonly Item[], key: NotificationSubscriptionKey): string[] {
  const ids = items.flatMap((item) => {
    const subscriptions = item.subscriptions;
    const pk = item.pk;
    if (typeof pk !== "string" || item.sk !== "SUBSCRIPTIONS" || subscriptions === null || typeof subscriptions !== "object") return [];
    if ((subscriptions as Record<string, unknown>)[key] !== true || !pk.startsWith("IDENTITY#")) return [];
    return [pk.slice("IDENTITY#".length)];
  });
  return [...new Set(ids)];
}

export function telegramChatIds(items: readonly Item[]): number[] {
  return [...new Set(items.flatMap((item) => {
    if (item.platform !== "telegram") return [];
    const raw = item.direct_chat_id ?? item.chat_id;
    const value = typeof raw === "string" ? Number(raw) : raw;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? [value] : [];
  }))];
}

async function subscriptionItems(): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Key | undefined;
  do {
    const page = await database().send(new ScanCommand({
      TableName: requiredEnv("ACCESS_TABLE_NAME"),
      FilterExpression: "sk = :subscriptions",
      ExpressionAttributeValues: { ":subscriptions": "SUBSCRIPTIONS" },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

async function identityAccounts(identityId: string): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Key | undefined;
  do {
    const page = await database().send(new QueryCommand({
      TableName: requiredEnv("ACCESS_TABLE_NAME"),
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :identity",
      ExpressionAttributeValues: { ":identity": `IDENTITY#${identityId}` },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

export async function subscribedTelegramChatIds(
  key: NotificationSubscriptionKey,
  options: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }> = {},
): Promise<number[]> {
  const included = options.include === undefined ? null : new Set(options.include);
  const excluded = new Set(options.exclude ?? []);
  const identityIds = subscribedIdentityIds(await subscriptionItems(), key)
    .filter((identityId) => (included === null || included.has(identityId)) && !excluded.has(identityId));
  const accounts = await Promise.all(identityIds.map(identityAccounts));
  return telegramChatIds(accounts.flat());
}

export async function claimInvitationDelivery(invitationId: string): Promise<boolean> {
  try {
    await database().send(new UpdateCommand({
      TableName: requiredEnv("ACCESS_TABLE_NAME"),
      Key: { pk: `INVITATION#${invitationId}`, sk: "EVENT" },
      UpdateExpression: "SET #status = :delivering, delivery_started_at = :now",
      ConditionExpression: "#status = :ready",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":ready": "READY", ":delivering": "DELIVERING", ":now": new Date().toISOString() },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function completeInvitationDelivery(
  invitationId: string,
  status: InvitationDeliveryStatus,
  targetCount: number,
  successCount: number,
): Promise<void> {
  await database().send(new UpdateCommand({
    TableName: requiredEnv("ACCESS_TABLE_NAME"),
    Key: { pk: `INVITATION#${invitationId}`, sk: "EVENT" },
    UpdateExpression: "SET #status = :status, delivery_target_count = :targets, delivery_success_count = :successes, delivery_failure_count = :failures, delivery_completed_at = :now",
    ConditionExpression: "#status = :delivering",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": status, ":targets": targetCount, ":successes": successCount,
      ":failures": targetCount - successCount, ":now": new Date().toISOString(), ":delivering": "DELIVERING",
    },
  }));
}
