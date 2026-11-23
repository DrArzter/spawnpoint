import { type Identity, type Permission, permissions, reservedPermissions } from "../../access/domain.ts";
import { QueryCommand, UpdateCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { privateTelegramChatId, type AccessApprovedEvent } from "../../domain/access-events.ts";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { randomUUID } from "node:crypto";
import { type Response, response, type Event, parameter, parseJsonObject } from "./http.ts";
import { document, tableName, type Item } from "./access-store.ts";
import { requirePermission } from "./permissions.ts";
import { events } from "./clients.ts";
import { identityById } from "./identity-store.ts";
import { createIdentity } from "../../access/identity-creation.ts";
import { accessIndexName, accountItemKey, activeIdentityIndex, candidateIndex, identityIndex, profileKey } from "../../access/keys.ts";
import { callerCondition, canDelete, escalationRefusal, lastHolderRefusal } from "./owner-guard.ts";
import { listRoles, readDefaultRoleId, readRole } from "./role-store.ts";
import { passwordCredentials } from "./credentials.ts";
import { isConditionFailure } from "./conditions.ts";

export async function candidates(): Promise<Response> {
  const pages = await Promise.all([candidateIndex.requested, candidateIndex.observed].map((state) => document.send(new QueryCommand({
    TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": state }, ScanIndexForward: false,
  }))));
  return response(200, { candidates: pages.flatMap((page) => page.Items ?? []).map((item) => ({
    platform: item.platform, platformUserId: item.platform_user_id, displayName: item.display_name,
    username: item.username ?? null, email: item.email ?? null, photoUrl: item.photo_url ?? null, status: item.status,
    firstSeenAt: item.first_seen_at, lastSeenAt: item.last_seen_at, requestedAt: item.requested_at,
  })) });
}

// One lookup per address for the whole listing: several identities may share
// none, but a single identity's accounts are read twice over otherwise, and
// the answer cannot change while one response is being built.
function verificationReader(): (email: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (email) => {
    const pending = seen.get(email) ?? passwordCredentials.find(email).then((credential) => credential?.emailVerified === true);
    seen.set(email, pending);
    return pending;
  };
}

export async function identities(caller: Identity): Promise<Response> {
  const roles = new Map((await listRoles()).map((role) => [role.id, role]));
  const emailVerified = verificationReader();
  const profiles = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: accessIndexName,
    KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": activeIdentityIndex },
  }));
  const items = await Promise.all((profiles.Items ?? []).map(async (profile) => {
    const identityId = String(profile.identity_id);
    const accounts = await document.send(new QueryCommand({
      TableName: tableName,
      IndexName: accessIndexName,
      KeyConditionExpression: "gsi1pk = :identity",
      ExpressionAttributeValues: { ":identity": identityIndex(identityId) },
    }));
    return {
      id: identityId,
      displayName: profile.display_name,
      roleId: profile.role_id,
      directGrants: profile.direct_grants ?? [],
      canDelete: canDelete(caller, { id: identityId, role: roles.get(String(profile.role_id)) ?? null }),
      links: await Promise.all((accounts.Items ?? []).filter((account) => typeof account.platform === "string").map(async (account) => ({
        platform: account.platform,
        value: account.platform_user_id,
        handle: accountHandle(account),
        // Telegram vouches for its accounts. An email address is a claim until
        // a message to it has been answered, and the answer is kept on the
        // credential — this used to read "nothing sends one yet", which stopped
        // being true when email verification shipped and left every password
        // account listed as unverified however often its owner confirmed it.
        verified: account.platform !== passwordProviderId
          || (typeof account.email === "string" && await emailVerified(account.email)),
      }))),
    };
  }));
  return response(200, { identities: items });
}

function accountHandle(account: Item): string | null {
  if (typeof account.username === "string") return account.username;
  return typeof account.email === "string" ? account.email : null;
}

// Returns the conflict response, or null when the role changed.
async function commitRoleChange(callerIdentity: Identity, identityId: string, roleId: string, targetRoleId: string): Promise<Response | null> {
  // The target must still hold the role read above.
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: tableName, ...callerCondition(callerIdentity, targetRoleId) } },
      { Update: {
        TableName: tableName,
        Key: profileKey(identityId),
        UpdateExpression: "SET role_id = :roleId, updated_at = :now, updated_by = :by",
        ConditionExpression: "attribute_exists(pk) AND #status = :active AND role_id = :current",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":roleId": roleId, ":now": new Date().toISOString(), ":by": callerIdentity.id, ":active": "ACTIVE", ":current": targetRoleId,
        },
      } },
    ] }));
  } catch (error) {
    if (isConditionFailure(error)) return response(409, { error: "role_change_conflict" });
    throw error;
  }
  return null;
}

export async function updateRole(callerIdentity: Identity, identityId: string, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const roleId = typeof parsed.roleId === "string" ? parsed.roleId : "";
  const role = roleId === "" ? null : await readRole(roleId);
  if (role === null) return response(400, { error: "unknown_role" });
  if (identityId === callerIdentity.id && roleId !== callerIdentity.roleId) return response(409, { error: "self_role_change_forbidden" });
  const target = await identityById(identityId);
  if (target === null) return response(404, { error: "identity_not_found" });
  // Giving the new role and taking the old one away are both checked.
  const refusal = escalationRefusal(callerIdentity, [role, target.role ?? null]) ?? await lastHolderRefusal(target.roleId, roleId);
  if (refusal !== null) return refusal;
  const conflict = await commitRoleChange(callerIdentity, identityId, roleId, target.roleId);
  if (conflict !== null) return conflict;
  return response(200, { identityId, roleId });
}

type ApprovalInput = Readonly<{ roleId: string | null; directGrants: Permission[] }>;

type ApprovalInputResult = Readonly<{ value: ApprovalInput; error: null }> | Readonly<{ value: null; error: Response }>;

function approvalInput(body: string | undefined): ApprovalInputResult {
  const parsed = parseJsonObject({ body });
  const roleId = typeof parsed.roleId === "string" ? parsed.roleId : null;
  const requestedGrants = parsed.directGrants;
  const directGrants = Array.isArray(requestedGrants) && requestedGrants.every(
    (permission) => typeof permission === "string" && permissions.includes(permission as Permission),
  ) ? requestedGrants as Permission[] : [];
  if (requestedGrants !== undefined && (!Array.isArray(requestedGrants) || directGrants.length !== requestedGrants.length)) {
    return { value: null, error: response(400, { error: "invalid_direct_grant" }) };
  }
  if (directGrants.some((permission) => reservedPermissions.includes(permission))) {
    return { value: null, error: response(400, { error: "reserved_permission" }) };
  }
  return { value: { roleId, directGrants }, error: null };
}

async function publishAccessApproval(platform: string, candidate: Item, identityId: string, displayName: string, roleName: string): Promise<void> {
  if (platform !== "telegram") return;
  const telegramChatId = privateTelegramChatId(candidate.direct_chat_id ?? candidate.chat_id);
  if (telegramChatId === null) return;
  const detail: AccessApprovedEvent = {
    telegramChatId,
    identityId,
    displayName,
    roleName,
  };
  try {
    const published = await events.send(new PutEventsCommand({ Entries: [{
      Source: "spawnpoint.access",
      DetailType: "Access Approved",
      Detail: JSON.stringify(detail),
    }] }));
    if ((published.FailedEntryCount ?? 0) > 0) throw new Error(published.Entries?.[0]?.ErrorMessage ?? "EventBridge rejected access approval");
  } catch (error) {
    // Approval is already committed. A best-effort notification must not make
    // the client retry the access mutation and receive a false conflict.
    console.error("access approval notification was not published", error);
  }
}

export async function approve(identity: Identity, platform: string, platformUserId: string, body: string | undefined): Promise<Response> {
  const input = approvalInput(body);
  if (input.error !== null) return input.error;
  const { directGrants } = input.value;
  const role = await readRole(input.value.roleId ?? await readDefaultRoleId());
  if (role === null) return response(400, { error: "unknown_role" });
  const roleId = role.id;
  // A direct grant is an exception only a holder of the protected role makes.
  const forbidden = directGrants.length > 0 ? requirePermission(identity, "access.owner.grant") : escalationRefusal(identity, [role]);
  if (forbidden !== null) return forbidden;
  const account = accountItemKey(platform, platformUserId);
  const candidate = await document.send(new GetCommand({ TableName: tableName, Key: account }));
  if (candidate.Item === undefined || candidate.Item.identity_id !== undefined) return response(409, { error: "candidate_unavailable" });
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = String(candidate.Item.display_name ?? candidate.Item.email ?? platformUserId);
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      ...createIdentity({
        tableName, identityId, account: { provider: platform, subject: platformUserId }, displayName: name,
        roleId, directGrants, createdBy: identity.id, now,
      }),
    ] }));
  } catch (error) {
    // Another Owner approved or dismissed the candidate first.
    if (isConditionFailure(error)) return response(409, { error: "candidate_unavailable" });
    throw error;
  }
  await publishAccessApproval(platform, candidate.Item, identityId, name, role.name);
  return response(201, { identity: { id: identityId, displayName: name, roleId, directGrants } });
}

export async function dismiss(identity: Identity, platform: string, platformUserId: string): Promise<Response> {
  const now = new Date().toISOString();
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: accountItemKey(platform, platformUserId),
      UpdateExpression: "SET #status = :dismissed, gsi1pk = :state, gsi1sk = :now, dismissed_at = :now, dismissed_by = :by",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":dismissed": "DISMISSED", ":state": candidateIndex.dismissed, ":now": now, ":by": identity.id },
    }));
  } catch (error) {
    // The candidate was approved first, or no longer exists.
    if (isConditionFailure(error)) return response(409, { error: "candidate_unavailable" });
    throw error;
  }
  return response(204, null);
}

// An account is addressed by the platform that vouches for it and that
// platform's own id: Telegram's numeric user id, a password credential's uuid.
const PLATFORM_ID = /^[a-z][a-z0-9_-]{1,31}$/;

const PLATFORM_USER_ID = /^[A-Za-z0-9._:@-]{1,255}$/;

export const withCandidateAddress = (event: Event, handle: (platform: string, platformUserId: string) => Promise<Response>): Promise<Response> | Response => {
  const platform = parameter(event, "platform");
  const platformUserId = parameter(event, "platformUserId");
  if (!PLATFORM_ID.test(platform) || !PLATFORM_USER_ID.test(platformUserId)) return response(400, { error: "invalid_account_address" });
  return handle(platform, platformUserId);
};
