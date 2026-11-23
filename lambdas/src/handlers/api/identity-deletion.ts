import { type Identity } from "../../access/domain.ts";
import { type TableKey } from "../../access/keys.ts";
import {
  accessIndexName, accessInvitationPrefix, accountItemKey, accountSort, consolePrefix, downloadPrefix, emailActionPrefix, identityIndex,
  isLoginProviderSort, oauthCredentialPrefix, accessInvitationProofSort, parseAccountKey, playerInvitationPrefix, profileKey, profileSort,
  identityPartition, sessionAccountIndex,
} from "../../access/keys.ts";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DeleteCommand, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand,
  type QueryCommandInput, type ScanCommandInput, type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ReleaseHolders, resolveFromWorldRecords } from "../../control-plane/release-holders.ts";
import { ReleaseRefs } from "../../control-plane/release-refs.ts";
import { S3WorldReader, S3WorldRepository } from "../../control-plane/s3-world-repository.ts";
import { type WorldRecord } from "../../control-plane/world-registry.ts";
import { type Response, response } from "./http.ts";
import { document, tableName, type Item } from "./access-store.ts";
import { deleteIdentityAvatars } from "./avatars.ts";
import { callerCondition, escalationRefusal, lastHolderRefusal } from "./owner-guard.ts";
import { readRole } from "./role-store.ts";
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
  // Anonymising an owner rewrites the record: the holder of its release is already there, so this costs one read.
  releaseWorlds ??= ((s3) => new S3WorldRepository(s3, bucket, new ReleaseHolders(new ReleaseRefs(document), resolveFromWorldRecords(new S3WorldReader(s3, bucket)))))(new S3Client({}));
  return releaseWorlds;
}

type Key = TableKey;

type Account = Readonly<{ key: Key; provider: string; subject: string; email: string | null }>;

type Counts = {
  removed: { accounts: number; credentials: number; loginSessions: number; oauth: number; emailActions: number; invitations: number; playerInvitations: number; avatars: number };
  revoked: { accessInvitations: number };
  anonymised: { console: number; downloads: number; worlds: number; bootstrap: number };
};

const keyOf = (item: Item): Key => ({ pk: String(item.pk), sk: String(item.sk) });

async function queryAll(input: QueryCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new QueryCommand({ ...input, ExclusiveStartKey: cursor })); // NOSONAR paginated: the next token comes from the previous page
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

async function scanAll(input: ScanCommandInput): Promise<Item[]> {
  const items: Item[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await document.send(new ScanCommand({ ...input, ExclusiveStartKey: cursor })); // NOSONAR paginated: the next token comes from the previous page
    items.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor !== undefined);
  return items;
}

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < items.length; start += 10) await Promise.all(items.slice(start, start + 10).map(run)); // NOSONAR batches of 10 run one after another to bound the write rate
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
  const parsed = parseAccountKey(String(item.pk));
  if (parsed === null) return null;
  // A Telegram account has no email, whatever the item holds.
  return { key: keyOf(item), ...parsed, email: parsed.provider !== "telegram" && typeof item.email === "string" ? item.email : null };
}

async function partitionItems(identityId: string): Promise<Item[]> {
  return queryAll({
    TableName: tableName, KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": identityPartition(identityId) }, ConsistentRead: true,
  });
}

// The index can lag a link, so the provider markers in the partition, which
// a consistent read returns, name accounts too.
async function linkedAccounts(identityId: string, partition: readonly Item[]): Promise<Account[]> {
  const indexed = (await queryAll({
    TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :identity",
    ExpressionAttributeValues: { ":identity": identityIndex(identityId) },
  })).filter((item) => item.sk === accountSort && item.identity_id === identityId);
  const known = new Set(indexed.map((item) => String(item.pk)));
  const marked = await Promise.all(partition
    .filter((item) => isLoginProviderSort(String(item.sk)) && typeof item.provider === "string" && typeof item.subject === "string")
    .map((item) => accountItemKey(String(item.provider), String(item.subject)))
    .filter((key) => !known.has(key.pk))
    .map(async (key) => (await document.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item));
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
    TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :account",
    FilterExpression: "entity_type = :session",
    ExpressionAttributeValues: { ":account": sessionAccountIndex(account.provider, account.subject), ":session": "LOGIN_SESSION" },
  })));
  return pages.flat();
}

// ":subject0, :subject1, ..." for an IN list.
function placeholders(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(", ");
}

type Secondary = Readonly<{
  oauth: Item[]; emailActions: Item[]; invitee: Item[]; proofs: Item[]; playerInvitations: Item[];
  pendingInvitations: Item[]; console: Item[]; downloads: Item[]; bootstrap: Item | null;
}>;

// OAuth credentials, email actions and player invitations have no index by
// identity, so one paginated Scan finds them with everything else here.
async function secondaryRecords(identityId: string, accounts: readonly Account[]): Promise<Secondary> {
  const passwordSubjects = accounts.filter((account) => account.provider === passwordProviderId).map((account) => account.subject);
  const proofKeys = accounts.map((account) => accessInvitationProofSort(account.provider, account.subject));
  const values: Record<string, unknown> = { ":id": identityId };
  const filters = ["identity_id = :id", "created_by = :id", "sender_identity_id = :id"];
  if (passwordSubjects.length > 0) {
    passwordSubjects.forEach((subject, index) => { values[`:subject${index}`] = subject; });
    values[":emailAction"] = emailActionPrefix;
    filters.push(`(begins_with(pk, :emailAction) AND subject IN (${placeholders(":subject", passwordSubjects.length)}))`);
  }
  if (proofKeys.length > 0) {
    proofKeys.forEach((key, index) => { values[`:proof${index}`] = key; });
    filters.push(`sk IN (${placeholders(":proof", proofKeys.length)})`);
  }
  const items = await scanAll({
    TableName: tableName, FilterExpression: filters.join(" OR "), ExpressionAttributeValues: values, ConsistentRead: true,
  });
  const named = (item: Item) => item.identity_id === identityId;
  const is = (item: Item, prefix: string, sk?: string) => String(item.pk).startsWith(prefix) && (sk === undefined || item.sk === sk);
  return {
    oauth: items.filter((item) => named(item) && (is(item, oauthCredentialPrefix("CODE"), "CODE") || is(item, oauthCredentialPrefix("REFRESH"), "REFRESH"))),
    emailActions: items.filter((item) => is(item, emailActionPrefix, "TOKEN")
      && (named(item) || (typeof item.subject === "string" && passwordSubjects.includes(item.subject)))),
    invitee: items.filter((item) => named(item) && is(item, accessInvitationPrefix, "TOKEN")),
    proofs: items.filter((item) => is(item, accessInvitationPrefix) && proofKeys.includes(String(item.sk))),
    playerInvitations: items.filter((item) => is(item, playerInvitationPrefix, "EVENT") && item.sender_identity_id === identityId),
    pendingInvitations: items.filter((item) => is(item, accessInvitationPrefix, "TOKEN")
      && item.created_by === identityId && item.status === "PENDING" && item.identity_id === undefined),
    console: items.filter((item) => named(item) && is(item, consolePrefix) && item.display_name !== undefined),
    downloads: items.filter((item) => named(item) && is(item, downloadPrefix) && item.display_name !== undefined),
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
type Transaction = NonNullable<TransactWriteCommandInput["TransactItems"]>;

type Deletion = Readonly<{
  identityId: string; roleId: string; partition: readonly Item[]; accounts: readonly Account[];
  credentials: readonly Item[]; bootstrap: Item | null;
}>;

// The caller check keeps an Owner when two Owners delete each other:
// the second transaction finds its caller gone, or conflicts with the first.
function deletionTransaction(caller: Identity, deletion: Deletion): Transaction {
  const { identityId, roleId, partition, accounts, credentials, bootstrap } = deletion;
  const transaction: Transaction = [{ ConditionCheck: { TableName: tableName, ...callerCondition(caller, roleId) } }];
  for (const item of partition) {
    transaction.push({ Delete: item.sk === profileSort
      ? { TableName: tableName, Key: keyOf(item), ConditionExpression: "attribute_exists(pk) AND role_id = :role", ExpressionAttributeValues: { ":role": roleId } }
      : { TableName: tableName, Key: keyOf(item) } });
  }
  for (const account of accounts) {
    transaction.push({ Delete: { TableName: tableName, Key: account.key, ConditionExpression: "identity_id = :id", ExpressionAttributeValues: { ":id": identityId } } });
  }
  for (const credential of credentials) {
    transaction.push({ Delete: { TableName: tableName, Key: keyOf(credential), ConditionExpression: "subject = :subject", ExpressionAttributeValues: { ":subject": credential.subject } } });
  }
  if (bootstrap !== null) {
    // Kept, so the configured Telegram account can never claim Owner again.
    transaction.push({ Update: {
      TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" },
      UpdateExpression: "REMOVE telegram_id, identity_id SET owner_removed_at = :now",
      ConditionExpression: "identity_id = :id",
      ExpressionAttributeValues: { ":id": identityId, ":now": new Date().toISOString() },
    } });
  }
  return transaction;
}

async function cancellationResponse(error: Cancellation, deletion: Deletion): Promise<Response> {
  const reasons = error.CancellationReasons ?? [];
  const failed = (index: number) => reasons[index]?.Code === "ConditionalCheckFailed";
  if (failed(0)) return response(409, { error: "caller_changed" });
  // Index 0 is the caller check; the partition's items follow it.
  const profileIndex = 1 + deletion.partition.findIndex((item) => item.sk === profileSort);
  if (failed(profileIndex)) {
    const current = await document.send(new GetCommand({
      TableName: tableName, Key: profileKey(deletion.identityId), ConsistentRead: true,
    }));
    return current.Item === undefined ? response(204, null) : response(409, { error: "identity_changed" });
  }
  if (reasons.some((reason) => reason.Code === "ConditionalCheckFailed")) return response(409, { error: "identity_changed" });
  return response(409, { error: "deletion_conflict" });
}

// Returns the refusal when the transaction was cancelled, or null once committed.
async function commitDeletion(caller: Identity, deletion: Deletion): Promise<Response | null> {
  try {
    await document.send(new TransactWriteCommand({ TransactItems: deletionTransaction(caller, deletion) }));
    return null;
  } catch (error) {
    if (!(error instanceof Error && error.name === "TransactionCanceledException")) throw error;
    return cancellationResponse(error as Cancellation, deletion);
  }
}

async function deleteLateAccounts(identityId: string, accounts: readonly Account[], counts: Counts): Promise<void> {
  await inBatches(accounts, async (account) => {
    try {
      await document.send(new DeleteCommand({
        TableName: tableName, Key: account.key, ConditionExpression: "identity_id = :id", ExpressionAttributeValues: { ":id": identityId },
      }));
      counts.removed.accounts += 1;
    } catch (error) {
      if (!conditionFailed(error)) throw error;
    }
  });
}

// Sweep 2. Access is already gone, so a failure is logged and the call
// still succeeds; what is left is pseudonymous or expires.
async function sweepRemainder(identityId: string, accounts: readonly Account[], counts: Counts, worlds: () => WorldStore): Promise<"complete" | "incomplete"> {
  try {
    counts.removed.loginSessions += await remove(await loginSessions(accounts));
    const leftover = await partitionItems(identityId);
    const lateAccounts = await linkedAccounts(identityId, leftover);
    await remove(leftover);
    await deleteLateAccounts(identityId, lateAccounts, counts);
    const after = await secondaryRecords(identityId, [...accounts, ...lateAccounts]);
    counts.removed.oauth += await remove(after.oauth);
    counts.removed.emailActions += await remove(after.emailActions);
    counts.removed.invitations += await remove([...after.invitee, ...after.proofs]);
    counts.removed.playerInvitations += await remove(after.playerInvitations);
    counts.revoked.accessInvitations += await revokePending(after.pendingInvitations);
    counts.anonymised.console += await forgetName(after.console);
    counts.anonymised.downloads += await forgetName(after.downloads);
    counts.anonymised.worlds += await anonymiseWorlds(identityId, worlds());
    counts.removed.avatars += await deleteIdentityAvatars(identityId);
    return "complete";
  } catch (error) {
    console.error(JSON.stringify({
      event: "identity_deletion_sweep_incomplete", deletedIdentityId: identityId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return "incomplete";
  }
}

export async function deleteIdentity(caller: Identity, identityId: string, worlds: () => WorldStore = worldsInReleaseBucket): Promise<Response> {
  if (identityId === caller.id) return response(409, { error: "self_delete_forbidden" });
  const profile = (await document.send(new GetCommand({
    TableName: tableName, Key: profileKey(identityId), ConsistentRead: true,
  }))).Item;
  if (profile === undefined) return response(204, null);
  const roleId = String(profile.role_id);
  // No escalation: the caller holds every permission of the target's role. The protected role keeps a holder.
  const refusal = escalationRefusal(caller, [await readRole(roleId)]) ?? await lastHolderRefusal(roleId, null);
  if (refusal !== null) return refusal;

  // Read.
  const partition = await partitionItems(identityId);
  if (!partition.some((item) => item.sk === profileSort)) return response(204, null);
  const accounts = await linkedAccounts(identityId, partition);
  const credentials = await passwordCredentialItems(accounts);
  const before = await secondaryRecords(identityId, accounts);
  const counts: Counts = {
    removed: { accounts: 0, credentials: 0, loginSessions: 0, oauth: 0, emailActions: 0, invitations: 0, playerInvitations: 0, avatars: 0 },
    revoked: { accessInvitations: 0 },
    anonymised: { console: 0, downloads: 0, worlds: 0, bootstrap: 0 },
  };

  // Sweep 1: no way to obtain a new access token is left.
  counts.removed.loginSessions += await remove(await loginSessions(accounts));
  counts.removed.oauth += await remove(before.oauth);
  counts.removed.emailActions += await remove(before.emailActions);

  // Commit.
  const cancelled = await commitDeletion(caller, { identityId, roleId, partition, accounts, credentials, bootstrap: before.bootstrap });
  if (cancelled !== null) return cancelled;
  counts.removed.accounts += accounts.length;
  counts.removed.credentials += credentials.length;
  counts.anonymised.bootstrap += before.bootstrap === null ? 0 : 1;

  const sweep2 = await sweepRemainder(identityId, accounts, counts, worlds);

  // The only record of the deletion. Ids and counts; never a name, address,
  // provider subject or Telegram id.
  console.info(JSON.stringify({
    event: "identity_deleted", actorIdentityId: caller.id, deletedIdentityId: identityId, roleId,
    ...counts, sweep2, at: new Date().toISOString(),
  }));
  return response(204, null);
}
