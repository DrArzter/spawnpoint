import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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

  await document.send(new UpdateCommand({
    TableName: env("ACCESS_TABLE_NAME"),
    Key: { pk: `TELEGRAM#${contact.id}`, sk: "ACCOUNT" },
    UpdateExpression: [
      "SET #platform = :platform",
      "platform_user_id = :platformUserId",
      "chat_id = :chatId",
      "#displayName = :displayName",
      "#username = :username",
      "first_seen_at = if_not_exists(first_seen_at, :firstSeenAt)",
      "last_seen_at = :lastSeenAt",
      "#status = if_not_exists(#status, :candidateStatus)",
      "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)",
      "gsi1sk = :lastSeenAt",
    ].join(", "),
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
};
