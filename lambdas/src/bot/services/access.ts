import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { requestAccountAccess, observeAccount } from "../../access/account-writes.ts";
import { can, identityFromRecord, type Permission } from "../../access/domain.ts";
import { accountItemKey, profileKey } from "../../access/keys.ts";
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
  identityId: (telegramId: number) => Promise<string | null>;
}>;

const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env("AWS_REGION") }));

async function writeContact(contact: TelegramContact, requested: boolean): Promise<void> {
  const now = new Date().toISOString();
  const subject = String(contact.id);
  const tableName = env("ACCESS_TABLE_NAME");
  await document.send(new UpdateCommand(observeAccount(tableName, {
    provider: "telegram", subject, displayName: contact.displayName, username: contact.username ?? null,
    chatId: String(contact.chatId),
    // Telegram lets the bot answer in groups, but personal subscriptions must
    // never redirect to whichever group the user happened to use most recently.
    ...(contact.chatId === contact.id ? { directChatId: String(contact.chatId) } : {}),
  }, requested, now)));
  // The account was just written, so only an identity link can fail this.
  if (requested) await document.send(new UpdateCommand(requestAccountAccess(tableName, "telegram", subject, now, false)));
}

async function linkedIdentityId(telegramId: number): Promise<string | null> {
  const account = await document.send(new GetCommand({
    TableName: env("ACCESS_TABLE_NAME"),
    Key: accountItemKey("telegram", String(telegramId)),
  }));
  const identityId = account.Item?.identity_id;
  return typeof identityId === "string" ? identityId : null;
}

export const accessStore: AccessStore = {
  observe: (contact) => writeContact(contact, false),
  request: (contact) => writeContact(contact, true),
  identityId: linkedIdentityId,
  hasPermission: async (telegramId, permission) => {
    const identityId = await linkedIdentityId(telegramId);
    if (identityId === null) return false;
    const profile = await document.send(new GetCommand({
      TableName: env("ACCESS_TABLE_NAME"),
      Key: profileKey(identityId),
    }));
    const item = profile.Item;
    return item !== undefined && item.status === "ACTIVE" && can(identityFromRecord(item), permission);
  },
};
