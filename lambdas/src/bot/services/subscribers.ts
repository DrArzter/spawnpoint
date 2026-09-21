import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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

export function verifiedEmailAddresses(accounts: readonly Item[], credentials: readonly Item[]): string[] {
  const verifiedBySubject = new Map(credentials.flatMap((credential) => {
    if (
      credential.entity_type !== "PASSWORD_CREDENTIAL"
      || credential.email_verified !== true
      || typeof credential.subject !== "string"
      || typeof credential.email !== "string"
    ) return [];
    return [[credential.subject, credential.email] as const];
  }));
  return [...new Set(accounts.flatMap((account) => {
    if (account.platform !== "password" || typeof account.platform_user_id !== "string" || typeof account.email !== "string") return [];
    const verified = verifiedBySubject.get(account.platform_user_id);
    return verified === account.email ? [verified] : [];
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

async function verifiedCredentials(accounts: readonly Item[]): Promise<Item[]> {
  const passwordAccounts = accounts.filter((account) => account.platform === "password" && typeof account.email === "string");
  return Promise.all(passwordAccounts.map(async (account) => {
    const result = await database().send(new GetCommand({
      TableName: requiredEnv("ACCESS_TABLE_NAME"),
      Key: { pk: `CREDENTIAL#EMAIL#${account.email as string}`, sk: "PASSWORD" },
      ConsistentRead: true,
    }));
    return result.Item ?? {};
  }));
}

export type NotificationTargets = Readonly<{
  telegramChatIds: readonly number[];
  emailAddresses: readonly string[];
}>;

export async function subscribedNotificationTargets(
  key: NotificationSubscriptionKey,
  options: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }> = {},
): Promise<NotificationTargets> {
  const included = options.include === undefined ? null : new Set(options.include);
  const excluded = new Set(options.exclude ?? []);
  const identityIds = subscribedIdentityIds(await subscriptionItems(), key)
    .filter((identityId) => (included === null || included.has(identityId)) && !excluded.has(identityId));
  const accounts = (await Promise.all(identityIds.map(identityAccounts))).flat();
  const credentials = await verifiedCredentials(accounts);
  return {
    telegramChatIds: telegramChatIds(accounts),
    emailAddresses: verifiedEmailAddresses(accounts, credentials),
  };
}

export async function subscribedTelegramChatIds(
  key: NotificationSubscriptionKey,
  options: Readonly<{ include?: readonly string[]; exclude?: readonly string[] }> = {},
): Promise<number[]> {
  return [...(await subscribedNotificationTargets(key, options)).telegramChatIds];
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
