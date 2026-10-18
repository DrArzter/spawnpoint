import { type LoginPrincipal } from "../../access/login-session.ts";
import { type Identity, type Permission } from "../../access/domain.ts";
import { UpdateCommand, GetCommand, TransactWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { type Item, document, tableName } from "./access-store.ts";
import { type Caller } from "./http.ts";
import { bootstrapOwnerTelegramId } from "./auth-config.ts";

export function accountKeyFor(platform: string, subject: string): string {
  // Preserve existing Telegram account keys while other providers join through
  // the provider-neutral login/session boundary.
  return platform === "telegram" ? `TELEGRAM#${subject}` : `ACCOUNT#${platform}#${subject}`;
}

export function accountKey(principal: LoginPrincipal): string {
  return accountKeyFor(principal.provider, principal.subject);
}

function identityFromItem(item: Item): Identity {
  return {
    id: String(item.identity_id),
    displayName: String(item.display_name),
    roleId: String(item.role_id),
    directGrants: Array.isArray(item.direct_grants) ? item.direct_grants as Permission[] : [],
  };
}

export async function observe(account: Caller): Promise<Item> {
  const now = new Date().toISOString();
  const updated = await document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: accountKey(account), sk: "ACCOUNT" },
    UpdateExpression: [
      "SET platform = :platform", "platform_user_id = :platformUserId", "display_name = :displayName",
      "username = :username", "photo_url = :photoUrl", "email = :email", "first_seen_at = if_not_exists(first_seen_at, :now)",
      "last_seen_at = :now", "#status = if_not_exists(#status, :observed)",
      "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)", "gsi1sk = :now",
    ].join(", "),
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":platform": account.provider, ":platformUserId": account.subject,
      ":displayName": account.displayName,
      ":username": account.username,
      ":photoUrl": account.photoUrl,
      ":email": account.email,
      ":now": now, ":observed": "OBSERVED", ":candidateIndex": "CANDIDATE#OBSERVED",
    },
    ReturnValues: "ALL_NEW",
  }));
  return updated.Attributes ?? {};
}

export async function resolveIdentity(principal: Caller, accountItem?: Item): Promise<Identity | null> {
  const account = accountItem ?? (await document.send(new GetCommand({
    TableName: tableName, Key: { pk: accountKey(principal), sk: "ACCOUNT" },
  }))).Item;
  const identityId = account?.identity_id;
  if (typeof identityId !== "string") return null;
  const profile = await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" },
  }));
  return profile.Item === undefined ? null : identityFromItem(profile.Item);
}

export async function bootstrapOwner(account: Caller): Promise<Identity | null> {
  if (account.provider !== "telegram" || account.subject !== bootstrapOwnerTelegramId) return null;
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = account.displayName;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: {
        pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: identityId, telegram_id: account.subject, claimed_at: now,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
        role_id: "owner", direct_grants: [], status: "ACTIVE", created_at: now,
        created_by: "bootstrap", gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: tableName, Key: { pk: accountKey(account), sk: "ACCOUNT" },
        UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :bootstrap",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`,
          ":now": now, ":bootstrap": "bootstrap",
        },
      } },
    ] }));
    return { id: identityId, displayName: name, roleId: "owner", directGrants: [] };
  } catch (error) {
    const existing = await resolveIdentity(account);
    if (existing !== null) return existing;
    console.error("owner_bootstrap_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown DynamoDB transaction failure",
    });
    throw error;
  }
}

export async function identityAccounts(identity: Identity): Promise<Item[]> {
  const result = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :identity",
    ExpressionAttributeValues: { ":identity": `IDENTITY#${identity.id}` },
  }));
  return (result.Items ?? []).filter((item) => item.sk === "ACCOUNT");
}

export async function identityById(identityId: string): Promise<Identity | null> {
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" }, ConsistentRead: true,
  }))).Item;
  return item === undefined || item.status !== "ACTIVE" ? null : identityFromItem(item);
}
