import { type Identity, builtInRoles, isBuiltInRoleId, type Permission, permissions } from "../../access/domain.ts";
import { QueryCommand, UpdateCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { passwordProviderId } from "../../access/password-login-provider.ts";
import { privateTelegramChatId, type AccessApprovedEvent } from "../../domain/access-events.ts";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { randomUUID } from "node:crypto";
import { type Response, response, type Event, parameter } from "./http.ts";
import { document, tableName, type Item } from "./access-store.ts";
import { requirePermission } from "./permissions.ts";
import { events } from "./clients.ts";
import { accountKeyFor } from "./identity-store.ts";

export function roles(identity: Identity): Response {
  const descriptions: Record<string, string> = {
    viewer: "Can see coarse server status only.",
    player: "Can view connection details, start a session and invite players.",
    operator: "Can operate sessions, console, metrics, releases and backups.",
    owner: "Full access to Spawnpoint, including access management.",
  };
  return response(200, { roles: Object.values(builtInRoles).map((role) => ({ ...role, description: descriptions[role.id], system: true })) });
}

export async function candidates(): Promise<Response> {
  const pages = await Promise.all(["CANDIDATE#REQUESTED", "CANDIDATE#OBSERVED"].map((state) => document.send(new QueryCommand({
    TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": state }, ScanIndexForward: false,
  }))));
  return response(200, { candidates: pages.flatMap((page) => page.Items ?? []).map((item) => ({
    platform: item.platform, platformUserId: item.platform_user_id, displayName: item.display_name,
    username: item.username ?? null, email: item.email ?? null, photoUrl: item.photo_url ?? null, status: item.status,
    firstSeenAt: item.first_seen_at, lastSeenAt: item.last_seen_at, requestedAt: item.requested_at,
  })) });
}

export async function identities(): Promise<Response> {
  const profiles = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": "IDENTITY#ACTIVE" },
  }));
  const items = await Promise.all((profiles.Items ?? []).map(async (profile) => {
    const identityId = String(profile.identity_id);
    const accounts = await document.send(new QueryCommand({
      TableName: tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :identity",
      ExpressionAttributeValues: { ":identity": `IDENTITY#${identityId}` },
    }));
    return {
      id: identityId,
      displayName: profile.display_name,
      roleId: profile.role_id,
      directGrants: profile.direct_grants ?? [],
      links: (accounts.Items ?? []).filter((account) => typeof account.platform === "string").map((account) => ({
        platform: account.platform,
        value: account.platform_user_id,
        handle: accountHandle(account),
        // Telegram vouches for its accounts. An email address is a claim until
        // a message to it has been answered, and nothing sends one yet.
        verified: account.platform !== passwordProviderId,
      })),
    };
  }));
  return response(200, { identities: items });
}

function accountHandle(account: Item): string | null {
  if (typeof account.username === "string") return account.username;
  return typeof account.email === "string" ? account.email : null;
}

export async function updateRole(callerIdentity: Identity, identityId: string, body: string | undefined): Promise<Response> {
  let parsed: { roleId?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const roleId = typeof parsed.roleId === "string" ? parsed.roleId : "";
  if (!isBuiltInRoleId(roleId)) return response(400, { error: "unknown_role" });
  if (identityId === callerIdentity.id && roleId !== callerIdentity.roleId) return response(409, { error: "self_role_change_forbidden" });
  if (roleId === "owner") {
    const forbidden = requirePermission(callerIdentity, "access.owner.grant");
    if (forbidden !== null) return forbidden;
  }
  await document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" },
    UpdateExpression: "SET role_id = :roleId, updated_at = :now, updated_by = :by",
    ConditionExpression: "attribute_exists(pk) AND #status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":roleId": roleId, ":now": new Date().toISOString(), ":by": callerIdentity.id, ":active": "ACTIVE" },
  }));
  return response(200, { identityId, roleId });
}

type ApprovalInput = Readonly<{ roleId: keyof typeof builtInRoles; directGrants: Permission[] }>;

type ApprovalInputResult = Readonly<{ value: ApprovalInput; error: null }> | Readonly<{ value: null; error: Response }>;

function approvalInput(body: string | undefined): ApprovalInputResult {
  let parsed: { roleId?: unknown; directGrants?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return { value: null, error: response(400, { error: "invalid_json" }) }; }
  const roleId = typeof parsed.roleId === "string" ? parsed.roleId : "viewer";
  if (!isBuiltInRoleId(roleId)) return { value: null, error: response(400, { error: "unknown_role" }) };
  const requestedGrants = parsed.directGrants;
  const directGrants = Array.isArray(requestedGrants) && requestedGrants.every(
    (permission) => typeof permission === "string" && permissions.includes(permission as Permission),
  ) ? requestedGrants as Permission[] : [];
  if (requestedGrants !== undefined && (!Array.isArray(requestedGrants) || directGrants.length !== requestedGrants.length)) {
    return { value: null, error: response(400, { error: "invalid_direct_grant" }) };
  }
  return { value: { roleId, directGrants }, error: null };
}

async function publishAccessApproval(platform: string, candidate: Item, identityId: string, displayName: string, roleId: keyof typeof builtInRoles): Promise<void> {
  if (platform !== "telegram") return;
  const telegramChatId = privateTelegramChatId(candidate.direct_chat_id ?? candidate.chat_id);
  if (telegramChatId === null) return;
  const detail: AccessApprovedEvent = {
    telegramChatId,
    identityId,
    displayName,
    roleName: builtInRoles[roleId].name,
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
  const { roleId, directGrants } = input.value;
  if (roleId === "owner" || directGrants.length > 0) {
    const forbidden = requirePermission(identity, "access.owner.grant");
    if (forbidden !== null) return forbidden;
  }
  const account = { pk: accountKeyFor(platform, platformUserId), sk: "ACCOUNT" };
  const candidate = await document.send(new GetCommand({ TableName: tableName, Key: account }));
  if (candidate.Item === undefined || candidate.Item.identity_id !== undefined) return response(409, { error: "candidate_unavailable" });
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = String(candidate.Item.display_name ?? candidate.Item.email ?? platformUserId);
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: tableName, Item: {
      pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
      role_id: roleId, direct_grants: directGrants, status: "ACTIVE", created_at: now,
      created_by: identity.id, gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
    }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: { TableName: tableName, Key: account,
      UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`, ":now": now, ":by": identity.id },
    } },
  ] }));
  await publishAccessApproval(platform, candidate.Item, identityId, name, roleId);
  return response(201, { identity: { id: identityId, displayName: name, roleId, directGrants } });
}

export async function dismiss(identity: Identity, platform: string, platformUserId: string): Promise<Response> {
  const now = new Date().toISOString();
  await document.send(new UpdateCommand({
    TableName: tableName, Key: { pk: accountKeyFor(platform, platformUserId), sk: "ACCOUNT" },
    UpdateExpression: "SET #status = :dismissed, gsi1pk = :state, gsi1sk = :now, dismissed_at = :now, dismissed_by = :by",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":dismissed": "DISMISSED", ":state": "CANDIDATE#DISMISSED", ":now": now, ":by": identity.id },
  }));
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
