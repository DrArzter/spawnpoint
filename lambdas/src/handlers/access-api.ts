import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { randomUUID } from "node:crypto";

import { builtInRoles, hasPermission, isBuiltInRoleId, permissions, type Identity, type Permission } from "../access/domain.ts";
import { directInvitationReadiness } from "../access/invitation-readiness.ts";
import { issueSessionToken, verifyLoginWidget, verifyMiniAppInitData, verifySessionToken, type TelegramProfile } from "../access/telegram-auth.ts";
import { defaultSubscriptions, validateSubscriptions } from "../access/subscriptions.ts";
import { privateTelegramChatId, type AccessApprovedEvent } from "../domain/access-events.ts";
import type { InvitationAudience, InvitationEvent } from "../domain/invitations.ts";
import { gameCatalog } from "../control-plane/catalog.ts";
import { awsControlPlaneSources, startSessionExecution, stopSessionExecution } from "../control-plane/aws.ts";
import { readControlPlaneSnapshot } from "../control-plane/read-model.ts";
import { planSessionOperation, type SessionAction } from "../control-plane/session-control.ts";

type Event = Readonly<{
  requestContext?: { http?: { method?: string } };
  routeKey?: string;
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string;
}>;
type Response = Readonly<{ statusCode: number; headers: Record<string, string>; body: string }>;
type Item = Record<string, unknown>;
type Caller = TelegramProfile;

const tableName = process.env.ACCESS_TABLE_NAME;
if (!tableName) throw new Error("missing environment variable: ACCESS_TABLE_NAME");
const bootstrapOwnerTelegramId = (process.env.BOOTSTRAP_OWNER_TELEGRAM_ID ?? "").trim();
const configuredBotTokenParameter = process.env.BOT_TOKEN_PARAMETER;
if (!configuredBotTokenParameter) throw new Error("missing environment variable: BOT_TOKEN_PARAMETER");
const botTokenParameter: string = configuredBotTokenParameter;
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const events = new EventBridgeClient({});
const ssm = new SSMClient({});
let botTokenPromise: Promise<string> | undefined;

function response(statusCode: number, body: unknown): Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: body === null ? "" : JSON.stringify(body) };
}

function botToken(): Promise<string> {
  botTokenPromise ??= ssm.send(new GetParameterCommand({ Name: botTokenParameter, WithDecryption: true })).then((result) => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Telegram bot token parameter is empty");
    return value;
  });
  return botTokenPromise;
}

async function caller(event: Event): Promise<Caller | null> {
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  return match === null ? null : verifySessionToken(match[1]!, await botToken());
}

function identityFromItem(item: Item): Identity {
  return {
    id: String(item.identity_id),
    displayName: String(item.display_name),
    roleId: String(item.role_id),
    directGrants: Array.isArray(item.direct_grants) ? item.direct_grants as Permission[] : [],
  };
}

async function observe(account: Caller): Promise<Item> {
  const now = new Date().toISOString();
  const updated = await document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `TELEGRAM#${account.telegramId}`, sk: "ACCOUNT" },
    UpdateExpression: [
      "SET platform = :platform", "platform_user_id = :platformUserId", "display_name = :displayName",
      "username = :username", "photo_url = :photoUrl", "first_seen_at = if_not_exists(first_seen_at, :now)",
      "last_seen_at = :now", "#status = if_not_exists(#status, :observed)",
      "gsi1pk = if_not_exists(gsi1pk, :candidateIndex)", "gsi1sk = :now",
    ].join(", "),
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":platform": "telegram", ":platformUserId": account.telegramId,
      ":displayName": account.displayName,
      ":username": account.username,
      ":photoUrl": account.photoUrl,
      ":now": now, ":observed": "OBSERVED", ":candidateIndex": "CANDIDATE#OBSERVED",
    },
    ReturnValues: "ALL_NEW",
  }));
  return updated.Attributes ?? {};
}

async function resolveIdentity(telegramId: string, accountItem?: Item): Promise<Identity | null> {
  const account = accountItem ?? (await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
  }))).Item;
  const identityId = account?.identity_id;
  if (typeof identityId !== "string") return null;
  const profile = await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" },
  }));
  return profile.Item === undefined ? null : identityFromItem(profile.Item);
}

async function bootstrapOwner(account: Caller): Promise<Identity | null> {
  if (account.telegramId !== bootstrapOwnerTelegramId) return null;
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = account.displayName;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: {
        pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: identityId, telegram_id: account.telegramId, claimed_at: now,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
        role_id: "owner", direct_grants: [], status: "ACTIVE", created_at: now,
        created_by: "bootstrap", gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: tableName, Key: { pk: `TELEGRAM#${account.telegramId}`, sk: "ACCOUNT" },
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
    const existing = await resolveIdentity(account.telegramId);
    if (existing !== null) return existing;
    console.error("owner_bootstrap_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown DynamoDB transaction failure",
    });
    throw error;
  }
}

function requirePermission(identity: Identity, permission: Permission): Response | null {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission) ? null : response(403, { error: "forbidden" });
}

async function session(account: Caller): Promise<Response> {
  const observed = await observe(account);
  const identity = await resolveIdentity(account.telegramId, observed) ?? await bootstrapOwner(account);
  if (identity !== null) {
    const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
    const bootstrap = await document.send(new GetCommand({ TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" } }));
    return response(200, { state: "active", identity, role, profile: {
      telegramId: account.telegramId, username: observed.username ?? null, photoUrl: observed.photo_url ?? null,
    }, bootstrap: bootstrap.Item === undefined ? { state: "unclaimed" } : {
      state: "claimed", ownerId: bootstrap.Item.identity_id, telegramId: bootstrap.Item.telegram_id, claimedAt: bootstrap.Item.claimed_at,
    } });
  }
  return response(200, { state: "visitor", candidate: {
    telegramId: account.telegramId, displayName: observed.display_name, username: observed.username ?? null,
    photoUrl: observed.photo_url ?? null, status: observed.status ?? "OBSERVED",
  } });
}

async function requestAccess(account: Caller): Promise<Response> {
  const now = new Date().toISOString();
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `TELEGRAM#${account.telegramId}`, sk: "ACCOUNT" },
      UpdateExpression: "SET #status = :requested, gsi1pk = :candidateIndex, requested_at = if_not_exists(requested_at, :now), gsi1sk = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":requested": "REQUESTED", ":candidateIndex": "CANDIDATE#REQUESTED", ":now": now },
    }));
  } catch {
    if (await resolveIdentity(account.telegramId) !== null) return response(409, { error: "already_approved" });
    throw new Error("access candidate is unavailable");
  }
  return response(202, { state: "requested" });
}

async function controlPlane(identity: Identity): Promise<Response> {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  const can = (permission: Permission) => role !== undefined && hasPermission(identity, role, permission);
  const snapshot = await readControlPlaneSnapshot(awsControlPlaneSources, {
    includeInfrastructure: can("access.manage"),
    includeDesiredRelease: can("release.read"),
  });
  return response(200, snapshot);
}

async function controlSession(identity: Identity, action: SessionAction, gameId: string, worldId: string): Promise<Response> {
  const [hosts, operations] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
  ]);
  const plan = planSessionOperation(gameId, worldId, action, hosts, operations);
  if (plan.kind === "reject") return response(plan.reason === "unknown_world" ? 404 : 409, { error: plan.reason });
  if (plan.kind === "noop") return response(200, { result: plan.reason });
  const operationId = `panel-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const requestedBy = `identity:${identity.id}`;
  if (action === "start") await startSessionExecution(operationId, plan.host.providerRef, requestedBy, worldId);
  else await stopSessionExecution(operationId, plan.host.providerRef, requestedBy, worldId);
  return response(202, { result: "requested", operationId });
}

function roles(identity: Identity): Response {
  const descriptions: Record<string, string> = {
    viewer: "Can see coarse server status only.",
    player: "Can view connection details, start a session and invite players.",
    operator: "Can operate sessions, console, metrics, releases and backups.",
    owner: "Full access to Spawnpoint, including access management.",
  };
  return response(200, { roles: Object.values(builtInRoles).map((role) => ({ ...role, description: descriptions[role.id], system: true })) });
}

async function subscriptions(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: { pk: `IDENTITY#${identity.id}`, sk: "SUBSCRIPTIONS" }, ConsistentRead: true }));
  return response(200, { subscriptions: { ...defaultSubscriptions(), ...(stored.Item?.subscriptions as Record<string, boolean> | undefined ?? {}) } });
}

async function updateSubscriptions(identity: Identity, body: string | undefined): Promise<Response> {
  let parsed: { subscriptions?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const next = validateSubscriptions(parsed.subscriptions);
  if (next === null) return response(400, { error: "invalid_subscriptions" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `IDENTITY#${identity.id}`, sk: "SUBSCRIPTIONS", subscriptions: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { subscriptions: next });
}

async function candidates(): Promise<Response> {
  const pages = await Promise.all(["CANDIDATE#REQUESTED", "CANDIDATE#OBSERVED"].map((state) => document.send(new QueryCommand({
    TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": state }, ScanIndexForward: false,
  }))));
  return response(200, { candidates: pages.flatMap((page) => page.Items ?? []).map((item) => ({
    platform: item.platform, platformUserId: item.platform_user_id, displayName: item.display_name,
    username: item.username, photoUrl: item.photo_url, status: item.status,
    firstSeenAt: item.first_seen_at, lastSeenAt: item.last_seen_at, requestedAt: item.requested_at,
  })) });
}

async function identities(): Promise<Response> {
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
        verified: true,
      })),
    };
  }));
  return response(200, { identities: items });
}

async function invitationRecipients(identity: Identity): Promise<Response> {
  const profiles = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": "IDENTITY#ACTIVE" },
  }));
  const candidates = (profiles.Items ?? []).filter((profile) => profile.identity_id !== identity.id);
  const recipients = await Promise.all(candidates.map(async (profile) => {
    const identityId = String(profile.identity_id);
    const subscriptions = await document.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `IDENTITY#${identityId}`, sk: "SUBSCRIPTIONS" },
      ConsistentRead: true,
    }));
    const subscriptionMap = subscriptions.Item?.subscriptions;
    const directEnabled = subscriptionMap !== null && typeof subscriptionMap === "object"
      && (subscriptionMap as Record<string, unknown>)["invitation.direct"] === true;
    const accounts = directEnabled ? await document.send(new QueryCommand({
      TableName: tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :identity",
      ExpressionAttributeValues: { ":identity": `IDENTITY#${identityId}` },
    })) : { Items: [] };
    return {
      id: identityId,
      displayName: String(profile.display_name),
      delivery: directInvitationReadiness(subscriptions.Item, accounts.Items ?? []),
    };
  }));
  return response(200, { recipients: recipients.sort((left, right) => left.displayName.localeCompare(right.displayName)) });
}

async function createInvitation(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { audience?: unknown; recipientIdentityIds?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const audience = parsed.audience;
  if (audience !== "broadcast" && audience !== "direct") return response(400, { error: "invalid_audience" });
  const requested = parsed.recipientIdentityIds;
  if (audience === "direct" && (!Array.isArray(requested) || requested.length === 0 || requested.length > 100 || !requested.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)))) {
    return response(400, { error: "invalid_recipients" });
  }
  const recipientIdentityIds = audience === "direct" ? [...new Set(requested as string[])].filter((id) => id !== identity.id) : [];
  if (audience === "direct" && recipientIdentityIds.length === 0) return response(400, { error: "invalid_recipients" });
  const game = gameCatalog.find((candidate) => candidate.id === gameId);
  const world = game?.worlds.find((candidate) => candidate.id === worldId);
  if (game === undefined || world === undefined) return response(404, { error: "unknown_world" });

  if (audience === "direct") {
    const profiles = await Promise.all(recipientIdentityIds.map((id) => document.send(new GetCommand({
      TableName: tableName, Key: { pk: `IDENTITY#${id}`, sk: "PROFILE" }, ProjectionExpression: "identity_id, #status",
      ExpressionAttributeNames: { "#status": "status" },
    }))));
    if (profiles.some((profile) => profile.Item?.status !== "ACTIVE")) return response(400, { error: "invalid_recipients" });
  }

  const invitationId = randomUUID();
  const now = new Date().toISOString();
  const detail: InvitationEvent = {
    invitationId, audience: audience as InvitationAudience, gameId, gameName: game.displayName,
    worldId, worldName: world.displayName, senderIdentityId: identity.id,
    senderDisplayName: identity.displayName, recipientIdentityIds,
  };
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `INVITATION#${invitationId}`, sk: "EVENT", invitation_id: invitationId, audience,
    game_id: gameId, world_id: worldId, sender_identity_id: identity.id,
    recipient_identity_ids: recipientIdentityIds, status: "READY", created_at: now, published_at: now,
    gsi1pk: `INVITATION#SENDER#${identity.id}#GAME#${gameId}#WORLD#${worldId}`, gsi1sk: `${now}#${invitationId}`,
  } }));
  const published = await events.send(new PutEventsCommand({ Entries: [{
    EventBusName: process.env.EVENT_BUS_NAME ?? "default", Source: "spawnpoint.access",
    DetailType: "Game Invitation", Detail: JSON.stringify(detail),
  }] }));
  if ((published.FailedEntryCount ?? 0) > 0) {
    await document.send(new UpdateCommand({ TableName: tableName, Key: { pk: `INVITATION#${invitationId}`, sk: "EVENT" },
      UpdateExpression: "SET #status = :failed", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":failed": "PUBLISH_FAILED" },
    }));
    return response(502, { error: "invitation_publish_failed" });
  }
  return response(202, { invitation: { id: invitationId, audience, recipientCount: audience === "direct" ? recipientIdentityIds.length : null, state: "queued" } });
}

async function invitationHistory(identity: Identity, gameId: string, worldId: string): Promise<Response> {
  const page = await document.send(new QueryCommand({
    TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :sender",
    ExpressionAttributeValues: { ":sender": `INVITATION#SENDER#${identity.id}#GAME#${gameId}#WORLD#${worldId}` }, ScanIndexForward: false, Limit: 5,
  }));
  return response(200, { invitations: (page.Items ?? [])
    .map((item) => ({
      id: item.invitation_id, audience: item.audience, status: item.status,
      recipientCount: Array.isArray(item.recipient_identity_ids) ? item.recipient_identity_ids.length : null,
      targetCount: item.delivery_target_count ?? null, successCount: item.delivery_success_count ?? null,
      failureCount: item.delivery_failure_count ?? null, createdAt: item.created_at,
    })) });
}

async function updateRole(callerIdentity: Identity, identityId: string, body: string | undefined): Promise<Response> {
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

async function approve(identity: Identity, telegramId: string, body: string | undefined): Promise<Response> {
  let parsed: { roleId?: unknown; directGrants?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const roleId = typeof parsed.roleId === "string" ? parsed.roleId : "viewer";
  if (!isBuiltInRoleId(roleId)) return response(400, { error: "unknown_role" });
  const requestedGrants = parsed.directGrants;
  const directGrants = Array.isArray(requestedGrants) && requestedGrants.every(
    (permission) => typeof permission === "string" && permissions.includes(permission as Permission),
  ) ? requestedGrants as Permission[] : [];
  if (requestedGrants !== undefined && (!Array.isArray(requestedGrants) || directGrants.length !== requestedGrants.length)) {
    return response(400, { error: "invalid_direct_grant" });
  }
  if (roleId === "owner" || directGrants.length > 0) {
    const forbidden = requirePermission(identity, "access.owner.grant");
    if (forbidden !== null) return forbidden;
  }
  const candidate = await document.send(new GetCommand({ TableName: tableName, Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" } }));
  if (candidate.Item === undefined || candidate.Item.identity_id !== undefined) return response(409, { error: "candidate_unavailable" });
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = String(candidate.Item.display_name ?? telegramId);
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: tableName, Item: {
      pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
      role_id: roleId, direct_grants: directGrants, status: "ACTIVE", created_at: now,
      created_by: identity.id, gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
    }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Update: { TableName: tableName, Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
      UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`, ":now": now, ":by": identity.id },
    } },
  ] }));
  const telegramChatId = privateTelegramChatId(candidate.Item.direct_chat_id ?? candidate.Item.chat_id);
  if (telegramChatId !== null) {
    const detail: AccessApprovedEvent = {
      telegramChatId,
      identityId,
      displayName: name,
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
  return response(201, { identity: { id: identityId, displayName: name, roleId, directGrants } });
}

async function dismiss(identity: Identity, telegramId: string): Promise<Response> {
  const now = new Date().toISOString();
  await document.send(new UpdateCommand({
    TableName: tableName, Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
    UpdateExpression: "SET #status = :dismissed, gsi1pk = :state, gsi1sk = :now, dismissed_at = :now, dismissed_by = :by",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":dismissed": "DISMISSED", ":state": "CANDIDATE#DISMISSED", ":now": now, ":by": identity.id },
  }));
  return response(204, null);
}

async function authenticate(event: Event): Promise<Response> {
  let parsed: { login?: unknown; initData?: unknown };
  try { parsed = event.body ? JSON.parse(event.body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const token = await botToken();
  const profile = typeof parsed.initData === "string"
    ? verifyMiniAppInitData(parsed.initData, token)
    : parsed.login !== null && typeof parsed.login === "object"
      ? verifyLoginWidget(parsed.login as Record<string, unknown>, token)
      : null;
  if (profile === null) return response(401, { error: "invalid_or_expired_telegram_login" });
  return response(200, { sessionToken: issueSessionToken(profile, token), expiresIn: 12 * 60 * 60 });
}

function me(identity: Identity): Response {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
  return response(200, { identity, role });
}

// Authority is declared here, once per route, and nowhere else. The dispatcher
// resolves exactly what a route's level requires and refuses before the handler
// runs, so a handler never decides whether it should have been reached — it
// only enforces rules that depend on its own payload, like granting the owner
// role. The keys are the API's own route keys, which is what API Gateway sends;
// access-api-routing.test.ts compares this table with the deployed list so
// neither side can drift silently.
type RouteAccess =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "identity" }>
  | Readonly<{ kind: "permission"; permission: Permission }>;

type Handler<Subject> = (subject: Subject, event: Event) => Promise<Response> | Response;
type Route = Readonly<{ access: RouteAccess; handle: Handler<never> }>;

// One constructor per access level, so each route reads as a sentence and its
// closure argument is typed by the level rather than asserted at the call.
const publicRoute = (handle: (event: Event) => Promise<Response> | Response): Route => ({
  access: { kind: "public" },
  handle: ((_subject: never, event: Event) => handle(event)) as Handler<never>,
});
const sessionRoute = (handle: Handler<Caller>): Route => ({ access: { kind: "session" }, handle: handle as Handler<never> });
const identityRoute = (handle: Handler<Identity>): Route => ({ access: { kind: "identity" }, handle: handle as Handler<never> });
const permissionRoute = (permission: Permission, handle: Handler<Identity>): Route => ({
  access: { kind: "permission", permission },
  handle: handle as Handler<never>,
});

const parameter = (event: Event, name: string): string => event.pathParameters?.[name] ?? "";

export const routes: Readonly<Record<string, Route>> = {
  "POST /auth/telegram": publicRoute((event) => authenticate(event)),

  "GET /session": sessionRoute((account) => session(account)),
  "POST /access/request": sessionRoute(async (account) => {
    await observe(account);
    return requestAccess(account);
  }),

  "GET /me": identityRoute((identity) => me(identity)),
  "GET /me/subscriptions": identityRoute((identity) => subscriptions(identity)),
  "PUT /me/subscriptions": identityRoute((identity, event) => updateSubscriptions(identity, event.body)),

  "GET /control-plane": permissionRoute("status.read", (identity) => controlPlane(identity)),
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity)),
  "GET /invitations/recipients": permissionRoute("invitation.send", (identity) => invitationRecipients(identity)),

  "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) =>
    controlSession(identity, "start", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/stop": permissionRoute("session.stop", (identity, event) =>
    controlSession(identity, "stop", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    createInvitation(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    invitationHistory(identity, parameter(event, "gameId"), parameter(event, "worldId"))),

  "GET /access/candidates": permissionRoute("access.manage", () => candidates()),
  "GET /access/identities": permissionRoute("access.manage", () => identities()),
  "POST /access/candidates/{telegramId}/approve": permissionRoute("access.manage", (identity, event) => {
    const telegramId = parameter(event, "telegramId");
    if (!/^\d+$/.test(telegramId)) return response(400, { error: "invalid_telegram_id" });
    return approve(identity, telegramId, event.body);
  }),
  "POST /access/candidates/{telegramId}/dismiss": permissionRoute("access.manage", (identity, event) => {
    const telegramId = parameter(event, "telegramId");
    if (!/^\d+$/.test(telegramId)) return response(400, { error: "invalid_telegram_id" });
    return dismiss(identity, telegramId);
  }),
  "POST /access/identities/{identityId}/role": permissionRoute("access.manage", (identity, event) => {
    const identityId = parameter(event, "identityId");
    if (!/^[0-9a-f-]{36}$/.test(identityId)) return response(400, { error: "invalid_identity_id" });
    return updateRole(identity, identityId, event.body);
  }),
};

export async function handler(event: Event): Promise<Response> {
  const routeKey = event.routeKey ?? `${event.requestContext?.http?.method ?? ""} ${event.rawPath ?? ""}`;
  const route = routes[routeKey];
  // Default deny: an unrouted request never reaches a handler, and neither does
  // a route somebody deployed without declaring its authority here.
  if (route === undefined) return response(404, { error: "not_found" });

  const call = (subject: unknown) =>
    (route.handle as (subject: unknown, event: Event) => Promise<Response> | Response)(subject, event);
  if (route.access.kind === "public") return call(undefined);

  const account = await caller(event);
  if (account === null) return response(401, { error: "invalid_or_expired_session" });
  if (route.access.kind === "session") return call(account);

  const identity = await resolveIdentity(account.telegramId);
  if (identity === null) return response(403, { error: "access_not_granted" });
  if (route.access.kind === "identity") return call(identity);

  const forbidden = requirePermission(identity, route.access.permission);
  return forbidden ?? call(identity);
}
