import { type Identity } from "../../access/domain.ts";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DeleteCommand, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand,
  type QueryCommandInput, type ScanCommandInput, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { S3WorldRepository } from "../../control-plane/s3-world-repository.ts";
import { type WorldRecord } from "../../control-plane/world-registry.ts";
import { type Response, response } from "./http.ts";
import { document, tableName, type Item } from "./access-store.ts";
import { requirePermission } from "./permissions.ts";
import { activeOwnerCount } from "./identity-store.ts";
import { credentialKey } from "./credentials.ts";

// --- Delete an identity and every record that names it (ADR-0071) -----------
// Read, sweep the credentials, commit the identity away in one transaction,
// then sweep what is left. Every step can run again; a repeat finds no profile.

export const deletedUserName = "Deleted user";

export type WorldStore = Pick<S3WorldRepository, "list" | "read" | "replace">;

let releaseWorlds: WorldStore | undefined;

function worldsInReleaseBucket(): WorldStore {
  const bucket = process.env.RELEASE_BUCKET;
  if (!bucket) throw new Error("missing environment variable: RELEASE_BUCKET");
  releaseWorlds ??= new S3WorldRepository(new S3Client({}), bucket);
  return releaseWorlds;
}

type Key = Readonly<{ pk: string; sk: string }>;

type Account = Readonly<{ key: Key; provider: string; subject: string; email: string | null }>;

type Counts = {
  removed: { accounts: number; credentials: number; loginSessions: number; oauth: number; emailActions: number; invitations: number; playerInvitations: number };
  revoked: { accessInvitations: number };
  anonymised: { console: number; downloads: number; worlds: number; bootstrap: number };
};

const keyOf = (item: Item): Key => ({ pk: String(item.pk), sk: String(item.sk) });

async function queryAll(input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({ ...input, ExclusiveStartKey: cursor }));
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

async function scanAll(input: ScanCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new ScanCommand({ ...input, ExclusiveStartKey: cursor }));
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < items.length; start += 10) await Promise.all(items.slice(start, start + 10).map(run));
}

function conditionFailed(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

// Plain deletes: a retry after a partial failure finishes the work.
async function remove(items: readonly Item[]): Promise<number> {
  await inBatches(items, (item) => document.send(new DeleteCommand({ TableName: tableName, Key: keyOf(item) })));
  return items.length;
}

function accountFromItem(item: Item): Account | null {
  const pk = String(item.pk);
  if (pk.startsWith("TELEGRAM#")) return { key: keyOf(item), provider: "telegram", subject: pk.slice("TELEGRAM#".length), email: null };
  const match = /^ACCOUNT#([^#]+)#(.+)$/.exec(pk);
  if (match === null) return null;
  return { key: keyOf(item), provider: match[1]!, subject: match[2]!, email: typeof item.email === "string" ? item.email : null };
}

async function partitionItems(identityId: string): Promise<Item[]> {
  return queryAll({
    TableName: tableName, KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `IDENTITY#${identityId}` }, ConsistentRead: true,
  });
}

// The index can lag a link, so the provider markers in the partition, which
// a consistent read returns, name accounts too.
async function linkedAccounts(identityId: string, partition: readonly Item[]): Promise<Account[]> {
  const indexed = (await queryAll({
    TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :identity",
    ExpressionAttributeValues: { ":identity": `IDENTITY#${identityId}` },
  })).filter((item) => item.sk === "ACCOUNT" && item.identity_id === identityId);
  const known = new Set(indexed.map((item) => String(item.pk)));
  const marked = await Promise.all(partition
    .filter((item) => String(item.sk).startsWith("LOGIN_PROVIDER#") && typeof item.provider === "string" && typeof item.subject === "string")
    .map((item) => String(item.provider) === "telegram" ? `TELEGRAM#${String(item.subject)}` : `ACCOUNT#${String(item.provider)}#${String(item.subject)}`)
    .filter((pk) => !known.has(pk))
    .map(async (pk) => (await document.send(new GetCommand({ TableName: tableName, Key: { pk, sk: "ACCOUNT" }, ConsistentRead: true }))).Item));
  return [...indexed, ...marked.filter((item): item is Item => item?.identity_id === identityId)]
    .map(accountFromItem).filter((account): account is Account => account !== null);
}

async function passwordCredentialItems(accounts: readonly Account[]): Promise<Item[]> {
  const found = await Promise.all(accounts
    .filter((account) => account.provider === passwordProviderId && account.email !== null)
    .map(async (account) => {
      const item = (await document.send(new GetCommand({ TableName: tableName, Key: credentialKey(account.email!), ConsistentRead: true }))).Item;
      return item?.subject === account.subject ? item : undefined;
    }));
  return found.filter((item): item is Item => item !== undefined);
}

// Login sessions are indexed by provider account, Telegram included.
async function loginSessions(accounts: readonly Account[]): Promise<Item[]> {
  const pages = await Promise.all(accounts.map((account) => queryAll({
    TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :account",
    FilterExpression: "entity_type = :session",
    ExpressionAttributeValues: { ":account": `ACCOUNT#${account.provider}#${account.subject}`, ":session": "LOGIN_SESSION" },
  })));
  return pages.flat();
}

type Secondary = Readonly<{
  oauth: Item[]; emailActions: Item[]; invitee: Item[]; proofs: Item[]; playerInvitations: Item[];
  pendingInvitations: Item[]; console: Item[]; downloads: Item[]; bootstrap: Item | null;
}>;

// OAuth credentials, email actions and player invitations have no index by
// identity, so one paginated Scan finds them with everything else here.
async function secondaryRecords(identityId: string, accounts: readonly Account[]): Promise<Secondary> {
  const passwordSubjects = accounts.filter((account) => account.provider === passwordProviderId).map((account) => account.subject);
  const proofKeys = accounts.map((account) => `PROOF#${account.provider}#${account.subject}`);
  const values: Record<string, unknown> = { ":id": identityId };
  const filters = ["identity_id = :id", "created_by = :id", "sender_identity_id = :id"];
  if (passwordSubjects.length > 0) {
    passwordSubjects.forEach((subject, index) => { values[`:subject${index}`] = subject; });
    values[":emailAction"] = "EMAIL_ACTION#";
    filters.push(`(begins_with(pk, :emailAction) AND subject IN (${passwordSubjects.map((_, index) => `:subject${index}`).join(", ")}))`);
  }
  if (proofKeys.length > 0) {
    proofKeys.forEach((key, index) => { values[`:proof${index}`] = key; });
    filters.push(`sk IN (${proofKeys.map((_, index) => `:proof${index}`).join(", ")})`);
  }
  const items = await scanAll({
    TableName: tableName, FilterExpression: filters.join(" OR "), ExpressionAttributeValues: values, ConsistentRead: true,
  });
  const named = (item: Item) => item.identity_id === identityId;
  const is = (item: Item, prefix: string, sk?: string) => String(item.pk).startsWith(prefix) && (sk === undefined || item.sk === sk);
  return {
    oauth: items.filter((item) => named(item) && (is(item, "OAUTH#CODE#", "CODE") || is(item, "OAUTH#REFRESH#", "REFRESH"))),
    emailActions: items.filter((item) => is(item, "EMAIL_ACTION#", "TOKEN")
      && (named(item) || (typeof item.subject === "string" && passwordSubjects.includes(item.subject)))),
    invitee: items.filter((item) => named(item) && is(item, "ACCESS_INVITATION#", "TOKEN")),
    proofs: items.filter((item) => is(item, "ACCESS_INVITATION#") && proofKeys.includes(String(item.sk))),
    playerInvitations: items.filter((item) => is(item, "INVITATION#", "EVENT") && item.sender_identity_id === identityId),
    pendingInvitations: items.filter((item) => is(item, "ACCESS_INVITATION#", "TOKEN")
      && item.created_by === identityId && item.status === "PENDING" && item.identity_id === undefined),
    console: items.filter((item) => named(item) && is(item, "CONSOLE#") && item.display_name !== undefined),
    downloads: items.filter((item) => named(item) && is(item, "DOWNLOAD#") && item.display_name !== undefined),
    bootstrap: items.find((item) => named(item) && item.pk === "SYSTEM" && item.sk === "BOOTSTRAP") ?? null,
  };
}

async function forgetName(items: readonly Item[]): Promise<number> {
  let count = 0;
  await inBatches(items, async (item) => {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName, Key: keyOf(item), UpdateExpression: "REMOVE display_name", ConditionExpression: "attribute_exists(pk)",
      }));
      count += 1;
    } catch (error) {
      // Its TTL removed it first.
      if (!conditionFailed(error)) throw error;
    }
  });
  return count;
}

async function revokePending(items: readonly Item[]): Promise<number> {
  let count = 0;
  const now = new Date().toISOString();
  await inBatches(items, async (item) => {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName, Key: keyOf(item),
        UpdateExpression: "SET #status = :revoked, revoked_at = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "REVOKED", ":pending": "PENDING", ":now": now },
      }));
      count += 1;
    } catch (error) {
      // Redeemed or revoked meanwhile.
      if (!conditionFailed(error)) throw error;
    }
  });
  return count;
}

function namesIdentity(record: WorldRecord, identityId: string): boolean {
  return [record.gameSettings?.updatedBy, record.whitelist?.updatedBy]
    .some((by) => by?.identityId === identityId && by.displayName !== deletedUserName);
}

function withoutName(record: WorldRecord, identityId: string): WorldRecord {
  const anonymous = <T extends { updatedBy: { identityId: string; displayName: string } }>(part: T | undefined): T | undefined =>
    part?.updatedBy.identityId === identityId ? { ...part, updatedBy: { identityId, displayName: deletedUserName } } : part;
  const gameSettings = anonymous(record.gameSettings);
  const whitelist = anonymous(record.whitelist);
  return { ...record, ...(gameSettings === undefined ? {} : { gameSettings }), ...(whitelist === undefined ? {} : { whitelist }) };
}

function preconditionFailed(error: unknown): boolean {
  return error instanceof Error && (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

// Only the current version: older versions of the record keep the name until
// the bucket expires them (ADR-0071).
async function anonymiseWorlds(identityId: string, worlds: WorldStore): Promise<number> {
  let count = 0;
  for (const { worldId } of (await worlds.list()).filter((record) => namesIdentity(record, identityId))) {
    for (let attempt = 1; ; attempt += 1) {
      const stored = await worlds.read(worldId);
      if (stored === null || !namesIdentity(stored.record, identityId)) break;
      try {
        await worlds.replace(withoutName(stored.record, identityId), stored.etag);
        count += 1;
        break;
      } catch (error) {
        if (!preconditionFailed(error) || attempt === 3) throw error;
      }
    }
  }
  return count;
}

type Cancellation = Error & { CancellationReasons?: readonly { Code?: string }[] };

export async function deleteIdentity(caller: Identity, identityId: string, worlds: () => WorldStore = worldsInReleaseBucket): Promise<Response> {
  if (identityId === caller.id) return response(409, { error: "self_delete_forbidden" });
  const profile = (await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" }, ConsistentRead: true,
  }))).Item;
  if (profile === undefined) return response(204, null);
  const roleId = String(profile.role_id);
  const targetIsOwner = roleId === "owner";
  if (targetIsOwner) {
    const forbidden = requirePermission(caller, "access.owner.grant");
    if (forbidden !== null) return forbidden;
    if (await activeOwnerCount() <= 1) return response(409, { error: "last_owner" });
  }

  // Read.
  const partition = await partitionItems(identityId);
  if (!partition.some((item) => item.sk === "PROFILE")) return response(204, null);
  const accounts = await linkedAccounts(identityId, partition);
  const credentials = await passwordCredentialItems(accounts);
  const before = await secondaryRecords(identityId, accounts);
  const counts: Counts = {
    removed: { accounts: 0, credentials: 0, loginSessions: 0, oauth: 0, emailActions: 0, invitations: 0, playerInvitations: 0 },
    revoked: { accessInvitations: 0 },
    anonymised: { console: 0, downloads: 0, worlds: 0, bootstrap: 0 },
  };

  // Sweep 1: no way to obtain a new access token is left.
  counts.removed.loginSessions += await remove(await loginSessions(accounts));
  counts.removed.oauth += await remove(before.oauth);
  counts.removed.emailActions += await remove(before.emailActions);

  // Commit. The caller check keeps an Owner when two Owners delete each other:
  // the second transaction finds its caller gone, or conflicts with the first.
  const transaction: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ ConditionCheck: {
    TableName: tableName, Key: { pk: `IDENTITY#${caller.id}`, sk: "PROFILE" },
    ConditionExpression: targetIsOwner ? "#status = :active AND role_id = :owner" : "#status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: targetIsOwner ? { ":active": "ACTIVE", ":owner": "owner" } : { ":active": "ACTIVE" },
  } }];
  for (const item of partition) {
    transaction.push({ Delete: item.sk === "PROFILE"
      ? { TableName: tableName, Key: keyOf(item), ConditionExpression: "attribute_exists(pk) AND role_id = :role", ExpressionAttributeValues: { ":role": roleId } }
      : { TableName: tableName, Key: keyOf(item) } });
  }
  const profileIndex = 1 + partition.findIndex((item) => item.sk === "PROFILE");
  for (const account of accounts) {
    transaction.push({ Delete: { TableName: tableName, Key: account.key, ConditionExpression: "identity_id = :id", ExpressionAttributeValues: { ":id": identityId } } });
  }
  for (const credential of credentials) {
    transaction.push({ Delete: { TableName: tableName, Key: keyOf(credential), ConditionExpression: "subject = :subject", ExpressionAttributeValues: { ":subject": credential.subject } } });
  }
  if (before.bootstrap !== null) {
    // Kept, so the configured Telegram account can never claim Owner again.
    transaction.push({ Update: {
      TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" },
      UpdateExpression: "REMOVE telegram_id, identity_id SET owner_removed_at = :now",
      ConditionExpression: "identity_id = :id",
      ExpressionAttributeValues: { ":id": identityId, ":now": new Date().toISOString() },
    } });
  }
  try {
    await document.send(new TransactWriteCommand({ TransactItems: transaction }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
    const reasons = (error as Cancellation).CancellationReasons ?? [];
    const failed = (index: number) => reasons[index]?.Code === "ConditionalCheckFailed";
    if (failed(0)) return response(409, { error: "caller_changed" });
    if (failed(profileIndex)) {
      const current = await document.send(new GetCommand({
        TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" }, ConsistentRead: true,
      }));
      return current.Item === undefined ? response(204, null) : response(409, { error: "identity_changed" });
    }
    if (reasons.some((reason) => reason.Code === "ConditionalCheckFailed")) return response(409, { error: "identity_changed" });
    return response(409, { error: "deletion_conflict" });
  }
  counts.removed.accounts += accounts.length;
  counts.removed.credentials += credentials.length;
  counts.anonymised.bootstrap += before.bootstrap === null ? 0 : 1;

  // Sweep 2. Access is already gone, so a failure is logged and the call
  // still succeeds; what is left is pseudonymous or expires.
  let sweep2: "complete" | "incomplete" = "complete";
  try {
    counts.removed.loginSessions += await remove(await loginSessions(accounts));
    const leftover = await partitionItems(identityId);
    const lateAccounts = await linkedAccounts(identityId, leftover);
    await remove(leftover);
    await inBatches(lateAccounts, async (account) => {
      try {
        await document.send(new DeleteCommand({
          TableName: tableName, Key: account.key, ConditionExpression: "identity_id = :id", ExpressionAttributeValues: { ":id": identityId },
        }));
        counts.removed.accounts += 1;
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
    });
    const after = await secondaryRecords(identityId, [...accounts, ...lateAccounts]);
    counts.removed.oauth += await remove(after.oauth);
    counts.removed.emailActions += await remove(after.emailActions);
    counts.removed.invitations += await remove([...after.invitee, ...after.proofs]);
    counts.removed.playerInvitations += await remove(after.playerInvitations);
    counts.revoked.accessInvitations += await revokePending(after.pendingInvitations);
    counts.anonymised.console += await forgetName(after.console);
    counts.anonymised.downloads += await forgetName(after.downloads);
    counts.anonymised.worlds += await anonymiseWorlds(identityId, worlds());
  } catch (error) {
    sweep2 = "incomplete";
    console.error(JSON.stringify({
      event: "identity_deletion_sweep_incomplete", deletedIdentityId: identityId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }

  // The only record of the deletion. Ids and counts; never a name, address,
  // provider subject or Telegram id.
  console.info(JSON.stringify({
    event: "identity_deleted", actorIdentityId: caller.id, deletedIdentityId: identityId, roleId,
    ...counts, sweep2, at: new Date().toISOString(),
  }));
  return response(204, null);
}
