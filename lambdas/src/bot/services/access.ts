import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { builtInRoles, hasPermission, isBuiltInRoleId, Permission } from "../../access/domain.ts";
import { env } from "./aws.ts";

export type TelegramContact = Readonly<{
  id: number;
  chatId: number;
  displayName: string;
  username?: string;
}>;

export type AccessStore = Readonly<{
  observe: (contact: TelegramContact) => Promise<void>;
  request: (contact: TelegramContact) => Promise<void>;
  hasPermission: (telegramId: number, permission: Permission) => Promise<boolean>;
}>;

const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env("AWS_REGION") }));

async function writeContact(contact: TelegramContact, requested: boolean): Promise<void> {
  const now = new Date().toISOString();
  const names: Record<string, string> = {
    "#status": "status",
    "#platform": "platform",
    "#displayName": "display_name",
    "#username": "username",
  };
  const values: Record<string, unknown> = {
    ":platform": "telegram",
    ":platformUserId": String(contact.id),
    ":chatId": String(contact.chatId),
    ":displayName": contact.displayName,
    ":username": contact.username ?? null,
    ":firstSeenAt": now,
    ":lastSeenAt": now,
    ":candidateStatus": requested ? "REQUESTED" : "OBSERVED",
    ":candidateIndex": requested ? "CANDIDATE#REQUESTED" : "CANDIDATE#OBSERVED",
  };

  const assignments = [
    "#platform = :platform",
    "platform_user_id = :platformUserId",
    "chat_id = :chatId",
    "#displayName = :displayName",
    "#username = :username",
    "first_seen_at = if_not_exists(first_seen_at, :firstSeenAt)",
    "last_seen_at = :lastSeenAt",
    "#status = if_not_exists(#status, :candidateStatus)",
    "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)",
    "gsi1sk = :lastSeenAt",
  ];
  // Telegram lets the bot answer in groups, but personal subscriptions must
  // never redirect to whichever group the user happened to use most recently.
  if (contact.chatId === contact.id) assignments.push("direct_chat_id = :chatId");

  await document.send(new UpdateCommand({
    TableName: env("ACCESS_TABLE_NAME"),
    Key: { pk: `TELEGRAM#${contact.id}`, sk: "ACCOUNT" },
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  if (requested) {
    await document.send(new UpdateCommand({
      TableName: env("ACCESS_TABLE_NAME"),
      Key: { pk: `TELEGRAM#${contact.id}`, sk: "ACCOUNT" },
      UpdateExpression: "SET #status = :requested, gsi1pk = :candidateIndex, requested_at = if_not_exists(requested_at, :now), gsi1sk = :now",
      ConditionExpression: "attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":requested": "REQUESTED",
        ":candidateIndex": "CANDIDATE#REQUESTED",
        ":now": now,
      },
    }));
  }
}

export const accessStore: AccessStore = {
  observe: (contact) => writeContact(contact, false),
  request: (contact) => writeContact(contact, true),
  hasPermission: async (telegramId, permission) => {
    const account = await document.send(new GetCommand({
      TableName: env("ACCESS_TABLE_NAME"),
      Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
    }));
    const identityId = account.Item?.identity_id;
    if (typeof identityId !== "string") return false;
    const profile = await document.send(new GetCommand({
      TableName: env("ACCESS_TABLE_NAME"),
      Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" },
    }));
    const item = profile.Item;
    if (item === undefined || typeof item.role_id !== "string" || !isBuiltInRoleId(item.role_id)) return false;
    const identity = {
      id: identityId,
      displayName: String(item.display_name ?? identityId),
      roleId: item.role_id,
      directGrants: Array.isArray(item.direct_grants) ? item.direct_grants as Permission[] : [],
    };
    return hasPermission(identity, builtInRoles[item.role_id], permission);
  },
};
