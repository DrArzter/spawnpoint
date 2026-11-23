import { type Identity, identityFromRecord, protectedRoleId } from "../../access/domain.ts";
import { observeAccount } from "../../access/account-writes.ts";
import { createIdentity } from "../../access/identity-creation.ts";
import { accessIndexName, accountItemKey, accountSort, activeIdentityIndex, identityIndex, profileKey } from "../../access/keys.ts";
import { UpdateCommand, GetCommand, TransactWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { type Item, document, tableName } from "./access-store.ts";
import { type Caller } from "./http.ts";
import { bootstrapOwnerTelegramId } from "./auth-config.ts";
import { withRole } from "./role-store.ts";

export async function observe(account: Caller): Promise<Item> {
  const updated = await document.send(new UpdateCommand({
    ...observeAccount(tableName, account, false, new Date().toISOString()),
    ReturnValues: "ALL_NEW",
  }));
  return updated.Attributes ?? {};
}

export async function resolveIdentity(principal: Caller, accountItem?: Item): Promise<Identity | null> {
  const account = accountItem ?? (await document.send(new GetCommand({
    TableName: tableName, Key: accountItemKey(principal.provider, principal.subject),
  }))).Item;
  const identityId = account?.identity_id;
  if (typeof identityId !== "string") return null;
  const profile = await document.send(new GetCommand({
    TableName: tableName, Key: profileKey(identityId),
  }));
  // The same rule as identityById: only an active identity acts.
  return profile.Item === undefined || profile.Item.status !== "ACTIVE" ? null : withRole(identityFromRecord(profile.Item));
}

async function bootstrapClaimed(): Promise<boolean> {
  const claim = await document.send(new GetCommand({
    TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" }, ConsistentRead: true,
  }));
  return claim.Item !== undefined;
}

// The bootstrap is claimed once. After that the configured account is an
// ordinary visitor, also when its Owner identity was deleted.
export async function bootstrapOwner(account: Caller): Promise<Identity | null> {
  if (account.provider !== "telegram" || account.subject !== bootstrapOwnerTelegramId) return null;
  if (await bootstrapClaimed()) return null;
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = account.displayName;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: {
        pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: identityId, telegram_id: account.subject, claimed_at: now,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      ...createIdentity({
        tableName, identityId, account: { provider: account.provider, subject: account.subject }, displayName: name,
        roleId: protectedRoleId, directGrants: [], createdBy: "bootstrap", now,
      }),
    ] }));
    return { id: identityId, displayName: name, roleId: protectedRoleId, directGrants: [] };
  } catch (error) {
    const existing = await resolveIdentity(account);
    if (existing !== null) return existing;
    if (await bootstrapClaimed()) return null;
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
    IndexName: accessIndexName,
    KeyConditionExpression: "gsi1pk = :identity",
    ExpressionAttributeValues: { ":identity": identityIndex(identity.id) },
  }));
  return (result.Items ?? []).filter((item) => item.sk === accountSort);
}

// Read from the index, so it can lag a write. A change that must keep an Owner
// also guards the caller's own profile in its transaction.
export async function activeOwnerCount(): Promise<number> {
  let count = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({ // NOSONAR paginated: the next token comes from the previous page
      TableName: tableName,
      IndexName: accessIndexName,
      KeyConditionExpression: "gsi1pk = :state",
      FilterExpression: "role_id = :protected",
      ExpressionAttributeValues: { ":state": activeIdentityIndex, ":protected": protectedRoleId },
      Select: "COUNT",
      ExclusiveStartKey: cursor,
    }));
    count += page.Count ?? 0;
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return count;
}

export async function identityById(identityId: string): Promise<Identity | null> {
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: profileKey(identityId), ConsistentRead: true,
  }))).Item;
  return item === undefined || item.status !== "ACTIVE" ? null : withRole(identityFromRecord(item));
}
