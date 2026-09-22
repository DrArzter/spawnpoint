import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { randomUUID } from "node:crypto";

import { builtInRoles, hasPermission, isBuiltInRoleId, permissions, type Identity, type Permission } from "../access/domain.ts";
import { directInvitationReadiness } from "../access/invitation-readiness.ts";
import {
  accessTokenLifetimeSeconds,
  equalRefreshHashes,
  expiredRefreshCookie,
  issueAccessToken,
  issueRefreshCredential,
  parseRefreshCredential,
  refreshCookie,
  refreshCookieName,
  refreshSessionLifetimeSeconds,
  verifyAccessToken,
  type LoginPrincipal,
} from "../access/login-session.ts";
import { authenticateWith, type LoginProvider } from "../access/login-provider.ts";
import { afterFailedSignIn, hashPassword, normalizeDisplayName, normalizeEmail, signInLocked, validatePassword, verifyPassword, type SignInGuard } from "../access/password-credential.ts";
import { emailActionTokenHash, issueEmailAction, renderEmailAction, type EmailAction, type EmailActionPurpose } from "../access/email-actions.ts";
import {
  createPasswordLoginProvider,
  passwordPrincipal,
  passwordProviderId,
  type PasswordCredential,
  type PasswordCredentialStore,
} from "../access/password-login-provider.ts";
import { verifySessionToken } from "../access/telegram-auth.ts";
import { createTelegramLoginProvider, telegramPrincipal } from "../access/telegram-login-provider.ts";
import { defaultAppearance, validateAppearance } from "../access/appearance.ts";
import { defaultSubscriptions, validateSubscriptions } from "../access/subscriptions.ts";
import { privateTelegramChatId, type AccessApprovedEvent } from "../domain/access-events.ts";
import type { InvitationAudience, InvitationEvent } from "../domain/invitations.ts";
import type { EmailSender } from "../email/email-sender.ts";
import { createResendEmailSender } from "../email/resend-email-sender.ts";
import { catalogWithPresets, gameCatalog } from "../control-plane/catalog.ts";
import { backupInventory } from "../control-plane/backups.ts";
import {
  awsControlPlaneSources,
  dashboardControlPlaneSources,
  listWorldBackups,
  materializePresetWorld,
  packDownloadUrl,
  readWorldRecord,
  replaceWorldAccess,
  startSessionExecution,
  stopSessionExecution,
  worldLifecycleExecution,
} from "../control-plane/aws.ts";
import { readControlPlaneSnapshot } from "../control-plane/read-model.ts";
import type { ControlPlaneSources } from "../control-plane/read-model.ts";
import type { WorldRecord } from "../control-plane/world-registry.ts";
import { packRelease, planFleetSessionOperation, planSessionOperation, stoppedHostRecoverySession, worldLifecycleNeedsStop, type SessionAction, type SessionPlan } from "../control-plane/session-control.ts";
import { issueSubscriptionTicket, subscriptionTicketItem, subscriptionTicketLifetimeSeconds } from "../control-plane/subscriptions.ts";
import { worldIdForName } from "../control-plane/world-registry.ts";

type Event = Readonly<{
  requestContext?: { http?: { method?: string } };
  routeKey?: string;
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
}>;
type Response = Readonly<{ statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }>;
type Item = Record<string, unknown>;
type Caller = LoginPrincipal;

const tableName = process.env.ACCESS_TABLE_NAME;
if (!tableName) throw new Error("missing environment variable: ACCESS_TABLE_NAME");
const bootstrapOwnerTelegramId = (process.env.BOOTSTRAP_OWNER_TELEGRAM_ID ?? "").trim();
const configuredBotTokenParameter = process.env.BOT_TOKEN_PARAMETER;
if (!configuredBotTokenParameter) throw new Error("missing environment variable: BOT_TOKEN_PARAMETER");
const botTokenParameter: string = configuredBotTokenParameter;
const configuredSessionSigningSecretParameter = process.env.SESSION_SIGNING_SECRET_PARAMETER;
if (!configuredSessionSigningSecretParameter) throw new Error("missing environment variable: SESSION_SIGNING_SECRET_PARAMETER");
const sessionSigningSecretParameter: string = configuredSessionSigningSecretParameter;
const telegramOidcClientId = (process.env.TELEGRAM_OIDC_CLIENT_ID ?? "").trim();
const controlPlaneViewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!controlPlaneViewTable) throw new Error("missing environment variable: CONTROL_PLANE_VIEW_TABLE");
const controlPlaneWebSocketUrl = process.env.CONTROL_PLANE_WEBSOCKET_URL;
if (!controlPlaneWebSocketUrl) throw new Error("missing environment variable: CONTROL_PLANE_WEBSOCKET_URL");
const refreshCookieSameSite: "Strict" | "None" = process.env.REFRESH_COOKIE_SAME_SITE === "None" ? "None" : "Strict";
// A sign-in adapter is an optional capability of a deployment (ADR-0045). Off,
// its routes answer as if they were never deployed, so the panel reads them as
// not connected rather than broken.
const passwordLoginEnabled = (process.env.PASSWORD_LOGIN_ENABLED ?? "false") === "true";
const passwordRegistrationEnabled = (process.env.PASSWORD_REGISTRATION_ENABLED ?? "false") === "true";
const emailDeliveryProvider = process.env.EMAIL_DELIVERY_PROVIDER ?? "none";
const panelUrl = (process.env.PANEL_URL ?? "").trim();
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const events = new EventBridgeClient({});
const ssm = new SSMClient({});
let botTokenPromise: Promise<string> | undefined;
let sessionSigningSecretPromise: Promise<string> | undefined;
let emailSenderPromise: Promise<EmailSender | null> | undefined;

function response(statusCode: number, body: unknown): Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: body === null ? "" : JSON.stringify(body) };
}

function responseWithCookie(statusCode: number, body: unknown, cookie: string): Response {
  return { ...response(statusCode, body), cookies: [cookie] };
}

function requestCookie(event: Event, name: string): string | null {
  const values = event.cookies ?? Object.entries(event.headers ?? {})
    .filter(([key]) => key.toLowerCase() === "cookie")
    .flatMap(([, value]) => value?.split(";") ?? []);
  for (const value of values) {
    const [cookieName, ...parts] = value.trim().split("=");
    if (cookieName === name) return parts.join("=");
  }
  return null;
}

function botToken(): Promise<string> {
  botTokenPromise ??= ssm.send(new GetParameterCommand({ Name: botTokenParameter, WithDecryption: true })).then((result) => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Telegram bot token parameter is empty");
    return value;
  });
  return botTokenPromise;
}

function sessionSigningSecret(): Promise<string> {
  sessionSigningSecretPromise ??= ssm.send(new GetParameterCommand({ Name: sessionSigningSecretParameter, WithDecryption: true })).then((result) => {
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Session signing secret parameter is empty");
    return value;
  });
  return sessionSigningSecretPromise;
}

function emailSender(): Promise<EmailSender | null> {
  emailSenderPromise ??= (async () => {
    if (emailDeliveryProvider === "none") return null;
    if (emailDeliveryProvider !== "resend") throw new Error(`unsupported email delivery provider: ${emailDeliveryProvider}`);
    const parameterName = process.env.RESEND_API_KEY_PARAMETER;
    const from = process.env.EMAIL_FROM;
    if (!parameterName || !from || !panelUrl) throw new Error("email delivery is incompletely configured");
    const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
    const apiKey = result.Parameter?.Value;
    if (!apiKey) throw new Error("Resend API key parameter is empty");
    const replyTo = process.env.EMAIL_REPLY_TO?.trim();
    return createResendEmailSender({ apiKey, from, ...(replyTo ? { replyTo } : {}) });
  })();
  return emailSenderPromise;
}

async function caller(event: Event): Promise<Caller | null> {
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization);
  if (match === null) return null;
  const current = verifyAccessToken(match[1]!, await sessionSigningSecret())?.principal;
  if (current !== undefined) return current;
  const legacy = verifySessionToken(match[1]!, await botToken());
  return legacy === null ? null : telegramPrincipal(legacy);
}

function accountKeyFor(platform: string, subject: string): string {
  // Preserve existing Telegram account keys while other providers join through
  // the provider-neutral login/session boundary.
  return platform === "telegram" ? `TELEGRAM#${subject}` : `ACCOUNT#${platform}#${subject}`;
}

function accountKey(principal: LoginPrincipal): string {
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

async function observe(account: Caller): Promise<Item> {
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

async function resolveIdentity(principal: Caller, accountItem?: Item): Promise<Identity | null> {
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

async function bootstrapOwner(account: Caller): Promise<Identity | null> {
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

function requirePermission(identity: Identity, permission: Permission): Response | null {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission) ? null : response(403, { error: "forbidden" });
}

// What this deployment can do, named once and derived from what it actually
// routes. A panel screen may exist before its route does, and asking afterwards
// only tells the reader they wasted the journey; this tells them beforehand.
//
// The names are the contract. The route keys are the truth, and
// `access-api-routing.test.ts` already proves that the table below and the
// deployed API describe the same routes, so a capability cannot claim something
// API Gateway does not serve.
const METRIC_RANGES: Readonly<Record<string, number>> = { "6h": 6, "24h": 24, "7d": 168 };

// Host metrics come from CloudWatch rather than from the host, so they answer
// for a window the host did not survive: an instance that was stopped all night
// has no datapoints, and that gap is the answer to "was it running".
async function hostMetrics(instanceId: string, range: string): Promise<Response> {
  if (!/^i-[0-9a-f]{8,32}$/.test(instanceId)) return response(400, { error: "invalid_instance_id" });
  const hours = METRIC_RANGES[range];
  if (hours === undefined) return response(400, { error: "invalid_range" });
  if (awsControlPlaneSources.readHostMetrics === undefined) return response(501, { error: "metrics_unavailable" });
  return response(200, { range, ...await awsControlPlaneSources.readHostMetrics(instanceId, hours) });
}

const capabilityRoutes: Readonly<Record<string, string>> = {
  releaseManifest: "GET /games/{gameId}/presets/{presetId}/releases/{version}",
  hostMetrics: "GET /hosts/{instanceId}/metrics",
  invitations: "POST /games/{gameId}/worlds/{worldId}/invitations",
  clientPacks: "GET /games/{gameId}/worlds/{worldId}/pack",
  backups: "GET /games/{gameId}/worlds/{worldId}/backups",
  worldLifecycle: "POST /games/{gameId}/worlds/{worldId}/wipe",
  accessManagement: "GET /access/identities",
};

export function deployedCapabilities(): readonly string[] {
  return Object.entries(capabilityRoutes)
    .filter(([, routeKey]) => Object.hasOwn(routes, routeKey))
    .map(([name]) => name);
}

async function session(account: Caller): Promise<Response> {
  const observed = await observe(account);
  const identity = await resolveIdentity(account, observed) ?? await bootstrapOwner(account);
  if (identity !== null) {
    const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
    const bootstrap = await document.send(new GetCommand({ TableName: tableName, Key: { pk: "SYSTEM", sk: "BOOTSTRAP" } }));
    return response(200, { state: "active", identity, role, capabilities: deployedCapabilities(), profile: accountProfile(account, observed),
      bootstrap: bootstrap.Item === undefined ? { state: "unclaimed" } : {
        state: "claimed", ownerId: bootstrap.Item.identity_id, telegramId: bootstrap.Item.telegram_id, claimedAt: bootstrap.Item.claimed_at,
      } });
  }
  return response(200, { state: "visitor", candidate: {
    ...accountProfile(account, observed), displayName: observed.display_name, status: observed.status ?? "OBSERVED",
  } });
}

// The account a session was signed in through, as the panel shows it. The
// Telegram id stays a named field because the owner bootstrap and the
// Mini App read it; every other provider is described by its handle or email.
function accountProfile(account: Caller, observed: Item) {
  return {
    provider: account.provider,
    platformUserId: account.subject,
    telegramId: account.provider === "telegram" ? account.subject : null,
    username: typeof observed.username === "string" ? observed.username : null,
    email: typeof observed.email === "string" ? observed.email : null,
    photoUrl: typeof observed.photo_url === "string" ? observed.photo_url : null,
  };
}

async function requestAccess(account: Caller): Promise<Response> {
  const now = new Date().toISOString();
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: accountKey(account), sk: "ACCOUNT" },
      UpdateExpression: "SET #status = :requested, gsi1pk = :candidateIndex, requested_at = if_not_exists(requested_at, :now), gsi1sk = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":requested": "REQUESTED", ":candidateIndex": "CANDIDATE#REQUESTED", ":now": now },
    }));
  } catch {
    if (await resolveIdentity(account) !== null) return response(409, { error: "already_approved" });
    throw new Error("access candidate is unavailable");
  }
  return response(202, { state: "requested" });
}

async function controlPlane(identity: Identity): Promise<Response> {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  const can = (permission: Permission) => role !== undefined && hasPermission(identity, role, permission);
  const snapshot = await readControlPlaneSnapshot(dashboardControlPlaneSources(), {
    includeInfrastructure: can("access.manage"),
    includeDesiredRelease: can("release.read"),
    // The host part of every address; the game's port completes it. Withheld
    // from a caller who may not read the connection, like any other reference.
    connectionHost: can("connection.read") ? process.env.CONNECTION_HOST ?? null : null,
  });
  return response(200, {
    ...snapshot,
    deployment: {
      placement: process.env.SPAWNPOINT_PLACEMENT === "shared" || process.env.SPAWNPOINT_PLACEMENT === "fleet"
        ? process.env.SPAWNPOINT_PLACEMENT : "single",
      launchEnabled: process.env.SPAWNPOINT_LAUNCH === "enabled",
      dnsAvailable: Boolean(process.env.GAME_DNS_SUFFIX),
    },
  });
}

async function createControlPlaneSubscription(identity: Identity): Promise<Response> {
  const ticket = issueSubscriptionTicket();
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  await document.send(new PutCommand({
    TableName: controlPlaneViewTable,
    Item: subscriptionTicketItem(ticket, identity.id, nowEpochSeconds),
    ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  }));
  return response(201, {
    url: controlPlaneWebSocketUrl,
    ticket,
    expiresInSeconds: subscriptionTicketLifetimeSeconds,
  });
}

async function controlSession(identity: Identity, action: SessionAction, gameId: string, worldId: string): Promise<Response> {
  const [hosts, operations, presets, worldRecords, lifecycle] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    awsControlPlaneSources.readLifecycle(gameId),
  ]);
  const effectiveCatalog = catalogWithPresets(presets, gameCatalog, worldRecords);
  const world = effectiveCatalog.find((game) => game.id === gameId)?.worlds.find((candidate) => candidate.id === worldId);
  const fleet = world?.placement === "fleet";
  if (action === "start" && fleet && process.env.SPAWNPOINT_LAUNCH !== "enabled") return response(409, { error: "fleet_unavailable" });
  const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
  const plan = fleet
    ? planFleetSessionOperation(gameId, worldId, action, operations, lifecycle, effectiveCatalog)
    : planSessionOperation(gameId, worldId, action, configuredHosts, operations, effectiveCatalog);
  if (plan.kind === "reject") return response(plan.reason === "unknown_world" ? 404 : 409, { error: plan.reason });
  const recoverySessionId = action === "stop" && !fleet ? stoppedHostRecoverySession(worldId, configuredHosts, lifecycle) : null;
  if (plan.kind === "noop" && recoverySessionId === null) return response(200, { result: plan.reason });
  const operationId = `panel-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const requestedBy = `identity:${identity.id}`;
  // The fleet workflow places the session itself. Its legacy instanceId input
  // is only a fallback for a missing placement, never a host selection.
  const hostId = fleet
    ? configuredHosts[0]?.providerRef
    : plan.kind === "execute" ? (plan as Extract<SessionPlan, { kind: "execute" }>).host.providerRef : configuredHosts[0]?.providerRef;
  if (!hostId) return response(409, { error: "configured_host_unavailable" });
  if (action === "start") {
    // No address in the request: the host's session summary answers with it
    // and the machine carries it back (ADR-0033).
    await startSessionExecution(operationId, hostId, requestedBy, gameId, worldId, fleet ? "fleet" : "single");
  }
  else {
    const activeSessionId = recoverySessionId ?? lifecycle?.activeSessionId;
    if (activeSessionId === null || activeSessionId === undefined) {
      return response(409, { error: "active_session_unavailable" });
    }
    await stopSessionExecution(operationId, hostId, requestedBy, gameId, activeSessionId, worldId);
  }
  return response(202, { result: "requested", operationId });
}

type WorldAccess = Readonly<{
  placement: WorldRecord["placement"];
  connectivity: WorldRecord["connectivity"];
  auth?: WorldRecord["auth"];
}>;

function parseWorldAccess(input: Readonly<{ placement?: unknown; connectivity?: unknown; auth?: unknown }>, useDefaults: boolean): WorldAccess | null {
  let placement = input.placement;
  if (placement === undefined && useDefaults) placement = process.env.SPAWNPOINT_PLACEMENT === "fleet" ? "fleet" : "configured";
  let connectivity = input.connectivity;
  if (connectivity === undefined && useDefaults) connectivity = placement === "fleet" ? "raw" : "zerotier";
  const auth = input.auth;
  if (placement !== "configured" && placement !== "fleet") return null;
  if (connectivity !== "zerotier" && connectivity !== "raw" && connectivity !== "route53") return null;
  if (auth !== undefined && auth !== "game" && auth !== "external") return null;
  if (connectivity !== "zerotier" && auth === undefined) return null;
  if (placement === "fleet" && (connectivity === "zerotier" || process.env.SPAWNPOINT_LAUNCH !== "enabled")) return null;
  if (placement === "configured" && connectivity !== "zerotier") return null;
  if (connectivity === "route53" && !process.env.GAME_DNS_SUFFIX) return null;
  return { placement, connectivity, ...(auth === undefined ? {} : { auth }) };
}

async function createWorld(identity: Identity, gameId: string, presetId: string, body: string | undefined): Promise<Response> {
  let parsed: { displayName?: unknown; release?: unknown; placement?: unknown; connectivity?: unknown; auth?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
  const release = typeof parsed.release === "string" ? parsed.release : "";
  if (displayName.length < 1 || displayName.length > 80) return response(400, { error: "invalid_world_name" });
  if (!/^[0-9]+\.[0-9]+$/.test(release)) return response(400, { error: "invalid_release" });
  const access = parseWorldAccess(parsed, true);
  if (access === null) return response(400, { error: "invalid_world_connectivity" });
  const presets = await (awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]));
  const preset = presets.find((candidate) => candidate.gameId === gameId && candidate.id === presetId);
  if (preset === undefined) return response(404, { error: "unknown_preset" });
  if (preset.buildStatus !== "ready" || preset.releases.length === 0) return response(409, { error: "preset_release_not_ready" });
  if (!preset.releases.includes(release)) return response(409, { error: "release_not_available" });
  const worldUuid = randomUUID();
  const worldId = worldIdForName(gameId, displayName, worldUuid);
  const createdAt = new Date().toISOString();
  const record = await materializePresetWorld(
    preset,
    { worldId, displayName, release },
    randomUUID(),
    createdAt,
    access,
  );
  return response(201, {
    world: {
      id: record.worldId,
      displayName: record.displayName,
      presetId: record.preset.id,
      generationId: record.currentGeneration.id,
      wipeNumber: 1,
      release: record.currentGeneration.release,
    },
    createdBy: identity.id,
  });
}

async function updateWorldSettings(gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  let parsed: { placement?: unknown; connectivity?: unknown; auth?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const access = parseWorldAccess(parsed, false);
  if (access === null) return response(400, { error: "invalid_world_connectivity" });
  const [lifecycle, operations] = await Promise.all([
    awsControlPlaneSources.readLifecycle(gameId),
    awsControlPlaneSources.listRunningOperations(),
  ]);
  if (operations.length > 0 || (lifecycle && (lifecycle.activeSessionId !== null || lifecycle.observedState !== "stopped"))) {
    return response(409, { error: "world_session_active" });
  }
  const result = await replaceWorldAccess(gameId, worldId, access);
  if (result === "missing") return response(404, { error: "unknown_world" });
  if (result === "conflict") return response(409, { error: "world_settings_conflict" });
  return response(200, { ...access, auth: access.auth ?? null });
}

// A backup carries the generation it was taken from, and that generation names
// the release it ran. Restoring reinstates the pair, so a release that is no
// longer in the store makes the restored generation unstartable — and today the
// refusal would arrive at the next start, from reconciliation, with the world
// already repointed. It is checked here, where somebody is still looking at the
// button they pressed. See ADR-0052.
export async function restorableRelease(
  record: WorldRecord,
  backupKey: string,
  readManifest: ControlPlaneSources["readReleaseManifest"],
): Promise<"ok" | "unknown_generation" | "release_missing"> {
  const generationId = /-(gen-[0-9a-f]{32})-/.exec(backupKey)?.[1];
  if (generationId === undefined) return "unknown_generation";
  const generation = [record.currentGeneration, ...record.previousGenerations].find((candidate) => candidate.id === generationId);
  if (generation === undefined) return "unknown_generation";
  if (readManifest === undefined) return "ok";
  const manifest = await readManifest(record.gameId, record.preset.id, generation.release);
  return manifest === null ? "release_missing" : "ok";
}

async function controlWorldLifecycle(
  identity: Identity,
  action: "archive" | "regenerate" | "restore" | "purge",
  gameId: string,
  worldId: string,
  body: string | undefined,
): Promise<Response> {
  let parsed: { backupKey?: unknown; confirmation?: unknown; release?: unknown } = {};
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const backupKey = action === "restore" && typeof parsed.backupKey === "string" ? parsed.backupKey : undefined;
  const release = action === "regenerate" && typeof parsed.release === "string" ? parsed.release : undefined;
  if (action === "restore" && (backupKey === undefined || !backupKey.startsWith(`worlds/${worldId}/archives/`))) {
    return response(400, { error: "invalid_backup_key" });
  }
  if (action === "purge" && parsed.confirmation !== worldId) return response(400, { error: "invalid_purge_confirmation" });
  if (action === "regenerate" && (release === undefined || !/^[0-9]+\.[0-9]+$/.test(release))) {
    return response(400, { error: "invalid_release" });
  }
  const [hosts, operations, worldRecords, lifecycle] = await Promise.all([
    awsControlPlaneSources.listHosts(),
    awsControlPlaneSources.listRunningOperations(),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
    awsControlPlaneSources.readLifecycle(gameId),
  ]);
  const record = worldRecords.find((candidate) => candidate.gameId === gameId && candidate.worldId === worldId);
  if (record === undefined) return response(404, { error: "unknown_materialized_world" });
  if (action === "purge" && record.status !== "archived") return response(409, { error: "world_not_archived" });
  if (action === "restore" && backupKey !== undefined) {
    const restorable = await restorableRelease(record, backupKey, awsControlPlaneSources.readReleaseManifest);
    if (restorable !== "ok") return response(409, { error: restorable });
  }
  if (operations.length > 0) return response(409, { error: "operation_in_progress" });
  const configuredHosts = hosts.filter((candidate) => candidate.provenance !== "launched");
  if (configuredHosts.length !== 1) return response(409, { error: "configured_host_unavailable" });
  const host = configuredHosts[0]!;
  if (record.placement !== "fleet" && (host.state === "pending" || host.state === "stopping" || host.state === "unknown")) {
    return response(409, { error: "host_transitioning" });
  }
  const operationId = `panel-world-${action}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const stopRequired = record.placement === "fleet"
    ? record.status === "active" && lifecycle?.activeWorldId === worldId && lifecycle.observedState !== "stopped"
    : worldLifecycleNeedsStop(record.status, host.state);
  if (stopRequired && !lifecycle?.activeSessionId) return response(409, { error: "active_session_unavailable" });
  await worldLifecycleExecution(
    operationId, host.providerRef, `identity:${identity.id}`, gameId, lifecycle?.activeSessionId ?? "none", worldId, action, backupKey, release,
    stopRequired, record.currentGeneration.id,
  );
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

async function appearance(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: { pk: `IDENTITY#${identity.id}`, sk: "APPEARANCE" }, ConsistentRead: true }));
  const found = validateAppearance(stored.Item?.appearance);
  // A stored value that no longer validates is treated as no value: a palette
  // is not worth failing a sign-in over.
  return response(200, { appearance: found ?? defaultAppearance() });
}

async function updateAppearance(identity: Identity, body: string | undefined): Promise<Response> {
  let parsed: { appearance?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const next = validateAppearance(parsed.appearance);
  if (next === null) return response(400, { error: "invalid_appearance" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `IDENTITY#${identity.id}`, sk: "APPEARANCE", appearance: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { appearance: next });
}

const RELEASE_ID = /^[a-z0-9][a-z0-9-]*$/;
const RELEASE_VERSION = /^[0-9]+\.[0-9]+$/;

// What a release contains, which until now lived only in S3 and in the mods
// directory of whichever host last installed it. Shaped rather than echoed: the
// manifest is a build artifact, and this is an API.
async function releaseManifest(gameId: string, presetId: string, version: string): Promise<Response> {
  if (!RELEASE_ID.test(gameId) || !RELEASE_ID.test(presetId) || !RELEASE_VERSION.test(version)) {
    return response(400, { error: "invalid_release_reference" });
  }
  const manifest = await awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, version) ?? null;
  if (manifest === null || typeof manifest !== "object") return response(404, { error: "unknown_release" });
  const value = manifest as Record<string, unknown>;
  const server = value.server as { mods?: unknown } | undefined;
  const loader = value.loader as { type?: unknown; version?: unknown } | undefined;
  const runtime = value.runtime as { image?: unknown } | undefined;
  const profile = value.source_profile as { id?: unknown; repository?: unknown; commit?: unknown } | undefined;
  const mods = Array.isArray(server?.mods) ? server.mods : [];
  return response(200, {
    gameId,
    presetId,
    release: typeof value.release === "string" ? value.release : version,
    gameVersion: typeof value.minecraft_version === "string" ? value.minecraft_version : null,
    loader: loader ? { type: String(loader.type ?? ""), version: String(loader.version ?? "") } : null,
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    changelog: typeof value.changelog === "string" && value.changelog !== "" ? value.changelog : null,
    runtimeImage: typeof runtime?.image === "string" ? runtime.image : null,
    source: profile ? { presetId: String(profile.id ?? ""), repository: String(profile.repository ?? ""), commit: String(profile.commit ?? "") } : null,
    mods: mods.map((entry) => {
      const mod = entry as Record<string, unknown>;
      return { file: String(mod.file ?? ""), sha256: String(mod.sha256 ?? ""), bytes: Number(mod.bytes ?? 0) };
    }),
  });
}

async function candidates(): Promise<Response> {
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

async function approve(identity: Identity, platform: string, platformUserId: string, body: string | undefined): Promise<Response> {
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

async function dismiss(identity: Identity, platform: string, platformUserId: string): Promise<Response> {
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

function loginSessionKey(loginSessionId: string): Record<string, string> {
  return { pk: `LOGIN_SESSION#${loginSessionId}`, sk: "REFRESH" };
}

function principalFromLoginSession(item: Item): LoginPrincipal | null {
  if (
    typeof item.provider !== "string" ||
    typeof item.subject !== "string" ||
    typeof item.display_name !== "string"
  ) return null;
  return {
    provider: item.provider,
    subject: item.subject,
    displayName: item.display_name,
    username: typeof item.username === "string" ? item.username : null,
    photoUrl: typeof item.photo_url === "string" ? item.photo_url : null,
    email: typeof item.email === "string" ? item.email : null,
  };
}

async function createLoginSession(principal: LoginPrincipal, signingSecret: string): Promise<Response> {
  const credential = issueRefreshCredential();
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + refreshSessionLifetimeSeconds;
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...loginSessionKey(credential.loginSessionId),
      entity_type: "LOGIN_SESSION",
      status: "ACTIVE",
      provider: principal.provider,
      subject: principal.subject,
      display_name: principal.displayName,
      username: principal.username,
      photo_url: principal.photoUrl,
      email: principal.email,
      token_hash: credential.tokenHash,
      created_at: createdAt,
      expires_at: expiresAt,
      ttl: expiresAt,
      gsi1pk: `ACCOUNT#${principal.provider}#${principal.subject}`,
      gsi1sk: `LOGIN_SESSION#${createdAt}#${credential.loginSessionId}`,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  return responseWithCookie(200, {
    accessToken: issueAccessToken(principal, credential.loginSessionId, signingSecret),
    expiresIn: accessTokenLifetimeSeconds,
  }, refreshCookie(credential.token, refreshCookieSameSite));
}

async function refreshLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, refreshCookieName);
  const supplied = cookie === null ? null : parseRefreshCredential(cookie);
  if (supplied === null) return response(401, { error: "invalid_or_expired_refresh_session" });

  const result = await document.send(new GetCommand({
    TableName: tableName,
    Key: loginSessionKey(supplied.loginSessionId),
    ConsistentRead: true,
  }));
  const item = result.Item;
  const now = Math.floor(Date.now() / 1000);
  const principal = item === undefined ? null : principalFromLoginSession(item);
  if (
    item === undefined || item.status !== "ACTIVE" ||
    typeof item.expires_at !== "number" || item.expires_at <= now ||
    typeof item.token_hash !== "string" || !equalRefreshHashes(item.token_hash, supplied.tokenHash) ||
    principal === null
  ) return response(401, { error: "invalid_or_expired_refresh_session" });

  const rotated = issueRefreshCredential(supplied.loginSessionId);
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: loginSessionKey(supplied.loginSessionId),
      UpdateExpression: "SET token_hash = :nextHash, last_refreshed_at = :now",
      ConditionExpression: "#status = :active AND token_hash = :previousHash AND expires_at > :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "ACTIVE",
        ":previousHash": supplied.tokenHash,
        ":nextHash": rotated.tokenHash,
        ":now": new Date().toISOString(),
        ":nowEpoch": now,
      },
    }));
  } catch {
    // Another tab may have rotated the shared cookie first. The client may retry
    // once with the newest cookie; do not revoke the whole login session here.
    return response(401, { error: "refresh_credential_rotated" });
  }
  const signingSecret = await sessionSigningSecret();
  return responseWithCookie(200, {
    accessToken: issueAccessToken(principal, supplied.loginSessionId, signingSecret),
    expiresIn: accessTokenLifetimeSeconds,
  }, refreshCookie(rotated.token, refreshCookieSameSite));
}

async function logoutLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, refreshCookieName);
  const supplied = cookie === null ? null : parseRefreshCredential(cookie);
  if (supplied !== null) {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName,
        Key: loginSessionKey(supplied.loginSessionId),
        UpdateExpression: "SET #status = :revoked, revoked_at = :now",
        ConditionExpression: "#status = :active AND token_hash = :tokenHash",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "ACTIVE",
          ":revoked": "REVOKED",
          ":tokenHash": supplied.tokenHash,
          ":now": new Date().toISOString(),
        },
      }));
    } catch {
      // Logout is idempotent and never reveals whether a credential existed.
    }
  }
  return responseWithCookie(204, null, expiredRefreshCookie(refreshCookieSameSite));
}

function objectBody(event: Event): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = event.body ? JSON.parse(event.body) as unknown : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

async function authenticate(provider: LoginProvider, event: Event): Promise<Response> {
  const attempt = objectBody(event);
  if (attempt === null) return response(400, { error: "invalid_json" });
  const principal = await authenticateWith(provider, attempt);
  if (principal === null) return response(401, { error: `invalid_or_expired_${provider.id}_login` });
  return createLoginSession(principal, await sessionSigningSecret());
}

// Email and password is one login adapter among peers. Its credential is kept
// by normalized address, independently from the Identity it may be linked to;
// the provider sees one credential at a time and never the table.
function credentialKey(email: string): Record<string, string> {
  return { pk: `CREDENTIAL#EMAIL#${email}`, sk: "PASSWORD" };
}

function credentialFromItem(item: Item): PasswordCredential | null {
  if (typeof item.subject !== "string" || typeof item.email !== "string" || typeof item.password_hash !== "string") return null;
  return {
    subject: item.subject,
    email: item.email,
    emailVerified: item.email_verified === true,
    displayName: typeof item.display_name === "string" ? item.display_name : item.email,
    passwordHash: item.password_hash,
    guard: {
      failedSignIns: typeof item.failed_sign_ins === "number" ? item.failed_sign_ins : 0,
      lockedUntilEpochSeconds: typeof item.locked_until === "number" ? item.locked_until : null,
    },
  };
}

// The guard is bookkeeping about an attempt that has already been judged. A
// credential deleted between the read and this write must not turn a wrong
// password into a server error.
async function updateCredentialGuard(email: string, expression: string, values: Record<string, unknown>): Promise<void> {
  try {
    await document.send(new UpdateCommand({
      TableName: tableName,
      Key: credentialKey(email),
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: values,
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
}

const passwordCredentials: PasswordCredentialStore = {
  async find(email) {
    // Consistent, so a lock written a moment ago is seen by the next attempt.
    const result = await document.send(new GetCommand({ TableName: tableName, Key: credentialKey(email), ConsistentRead: true }));
    return result.Item === undefined ? null : credentialFromItem(result.Item);
  },
  async recordFailure(email, observed, nowSeconds) {
    let current: SignInGuard = observed;
    // A consistent read alone cannot serialize two Lambdas that both observed
    // the same count. Compare the count in the write and retry from the latest
    // credential so every accepted failure advances the guard exactly once.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const next = afterFailedSignIn(current, nowSeconds);
      const expectedMissingOrZero = current.failedSignIns === 0;
      try {
        await document.send(new UpdateCommand({
          TableName: tableName,
          Key: credentialKey(email),
          UpdateExpression: "SET failed_sign_ins = :failed, locked_until = :lockedUntil, last_failed_sign_in_at = :now",
          ConditionExpression: expectedMissingOrZero
            ? "attribute_exists(pk) AND (attribute_not_exists(failed_sign_ins) OR failed_sign_ins = :expected)"
            : "attribute_exists(pk) AND failed_sign_ins = :expected",
          ExpressionAttributeValues: {
            ":expected": current.failedSignIns,
            ":failed": next.failedSignIns,
            ":lockedUntil": next.lockedUntilEpochSeconds,
            ":now": new Date().toISOString(),
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
      const latest = await this.find(email);
      if (latest === null || signInLocked(latest.guard, nowSeconds)) return;
      current = latest.guard;
    }
    throw new Error("password sign-in guard was updated too frequently");
  },
  recordSuccess: (email) => updateCredentialGuard(
    email,
    "SET failed_sign_ins = :zero, locked_until = :none, last_sign_in_at = :now",
    { ":zero": 0, ":none": null, ":now": new Date().toISOString() },
  ),
};

const passwordProvider = createPasswordLoginProvider({ credentials: passwordCredentials });
const telegramProvider = createTelegramLoginProvider({ oidcClientId: telegramOidcClientId, botToken });

// Proof-based providers all link through the same use-case. Password is kept
// separate because linking it creates a new credential and verifies a mailbox;
// Telegram, Google and Discord only need to verify a provider-owned proof.
const proofLinkProviders: ReadonlyMap<string, LoginProvider> = new Map([
  [telegramProvider.id, telegramProvider],
]);

function emailActionKey(tokenHash: string): Record<string, string> {
  return { pk: `EMAIL_ACTION#${tokenHash}`, sk: "TOKEN" };
}

function emailActionItem(
  purpose: EmailActionPurpose,
  action: EmailAction,
  credential: Pick<PasswordCredential, "subject" | "email" | "displayName">,
  identityId?: string,
): Item {
  const createdAt = new Date().toISOString();
  return {
    ...emailActionKey(action.tokenHash),
    entity_type: "EMAIL_ACTION_TOKEN",
    purpose,
    nonce: action.nonce,
    subject: credential.subject,
    email: credential.email,
    display_name: credential.displayName,
    status: "PENDING",
    created_at: createdAt,
    expires_at: action.expiresAtEpochSeconds,
    ttl: action.expiresAtEpochSeconds,
    ...(identityId === undefined ? {} : { identity_id: identityId }),
  };
}

async function deliverEmailAction(
  purpose: EmailActionPurpose,
  action: EmailAction,
  credential: Pick<PasswordCredential, "subject" | "email" | "displayName">,
): Promise<boolean> {
  const sender = await emailSender();
  if (sender === null) return false;
  await sender.send(renderEmailAction(purpose, { email: credential.email, displayName: credential.displayName, panelUrl, action }));
  return true;
}

async function replaceEmailAction(
  purpose: EmailActionPurpose,
  credential: PasswordCredential,
  identityId?: string,
): Promise<EmailAction> {
  const action = issueEmailAction(purpose);
  const nonceField = purpose === "verify_email" ? "email_verification_nonce" : "password_reset_nonce";
  await document.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: tableName,
      Key: credentialKey(credential.email),
      UpdateExpression: `SET ${nonceField} = :nonce`,
      ConditionExpression: "subject = :subject",
      ExpressionAttributeValues: { ":nonce": action.nonce, ":subject": credential.subject },
    } },
    { Put: {
      TableName: tableName,
      Item: emailActionItem(purpose, action, credential, identityId),
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ] }));
  return action;
}

function emailActionsUnavailable(): Response | null {
  return emailDeliveryProvider === "none" ? response(404, { error: "not_found" }) : null;
}

async function resendEmailVerification(event: Event): Promise<Response> {
  const unavailable = emailActionsUnavailable();
  if (unavailable !== null) return unavailable;
  const parsed = objectBody(event);
  const email = normalizeEmail(parsed?.email);
  if (email === null) return response(202, { result: "accepted" });
  const credential = await passwordCredentials.find(email);
  if (credential === null || credential.emailVerified) return response(202, { result: "accepted" });
  const account = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: accountKeyFor(passwordProviderId, credential.subject), sk: "ACCOUNT" },
    ConsistentRead: true,
  }));
  const action = await replaceEmailAction(
    "verify_email",
    credential,
    typeof account.Item?.identity_id === "string" ? account.Item.identity_id : undefined,
  );
  await deliverEmailAction("verify_email", action, credential);
  return response(202, { result: "accepted" });
}

function actionFromItem(item: Item | undefined, purpose: EmailActionPurpose, nowEpochSeconds: number): Item | null {
  if (
    item?.entity_type !== "EMAIL_ACTION_TOKEN" || item.purpose !== purpose || item.status !== "PENDING"
    || typeof item.nonce !== "string" || typeof item.subject !== "string" || typeof item.email !== "string"
    || typeof item.expires_at !== "number" || item.expires_at <= nowEpochSeconds
  ) return null;
  return item;
}

async function readEmailAction(event: Event, purpose: EmailActionPurpose): Promise<{ tokenHash: string; item: Item } | Response> {
  const parsed = objectBody(event);
  const tokenHash = emailActionTokenHash(typeof parsed?.token === "string" ? parsed.token : "");
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_email_action" });
  const result = await document.send(new GetCommand({ TableName: tableName, Key: emailActionKey(tokenHash), ConsistentRead: true }));
  const item = actionFromItem(result.Item, purpose, Math.floor(Date.now() / 1000));
  return item === null ? response(400, { error: "invalid_or_expired_email_action" }) : { tokenHash, item };
}

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function consumeEmailActionUpdate(tokenHash: string, item: Item, now: string): TransactionItem {
  return { Update: {
    TableName: tableName,
    Key: emailActionKey(tokenHash),
    UpdateExpression: "SET #status = :used, used_at = :now",
    ConditionExpression: "#status = :pending AND nonce = :nonce AND expires_at > :nowEpoch",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":used": "USED", ":pending": "PENDING", ":now": now, ":nonce": item.nonce,
      ":nowEpoch": Math.floor(Date.now() / 1000),
    },
  } };
}

async function verifyEmail(event: Event): Promise<Response> {
  const found = await readEmailAction(event, "verify_email");
  if ("statusCode" in found) return found;
  const { item, tokenHash } = found;
  const email = String(item.email);
  const subject = String(item.subject);
  const credentialResult = await document.send(new GetCommand({ TableName: tableName, Key: credentialKey(email), ConsistentRead: true }));
  const credential = credentialResult.Item === undefined ? null : credentialFromItem(credentialResult.Item);
  if (credential?.subject !== subject) return response(400, { error: "invalid_or_expired_email_action" });
  const now = new Date().toISOString();
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: credentialKey(email),
        UpdateExpression: "SET email_verified = :verified, verified_at = :now REMOVE email_verification_nonce",
        ConditionExpression: "subject = :subject AND email_verification_nonce = :nonce",
        ExpressionAttributeValues: { ":verified": true, ":now": now, ":subject": subject, ":nonce": item.nonce },
      } },
      consumeEmailActionUpdate(tokenHash, item, now),
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(400, { error: "invalid_or_expired_email_action" });
    }
    throw error;
  }
  return createLoginSession(passwordPrincipal(credential), await sessionSigningSecret());
}

async function requestPasswordReset(event: Event): Promise<Response> {
  const unavailable = emailActionsUnavailable();
  if (unavailable !== null) return unavailable;
  const email = normalizeEmail(objectBody(event)?.email);
  if (email === null) return response(202, { result: "accepted" });
  const credential = await passwordCredentials.find(email);
  if (!credential?.emailVerified) return response(202, { result: "accepted" });
  const action = await replaceEmailAction("reset_password", credential);
  await deliverEmailAction("reset_password", action, credential);
  return response(202, { result: "accepted" });
}

async function revokePasswordLoginSessions(subject: string): Promise<void> {
  const sessions = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :account",
    ExpressionAttributeValues: { ":account": `ACCOUNT#${passwordProviderId}#${subject}` },
  }));
  const now = new Date().toISOString();
  await Promise.all((sessions.Items ?? []).filter((item) => item.entity_type === "LOGIN_SESSION").map((item) => document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: item.pk, sk: item.sk },
    UpdateExpression: "SET #status = :revoked, revoked_at = :now",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":revoked": "REVOKED", ":now": now },
  }))));
}

async function resetPassword(event: Event): Promise<Response> {
  const parsed = objectBody(event);
  const passwordProblem = validatePassword(parsed?.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const found = await readEmailAction(event, "reset_password");
  if ("statusCode" in found) return found;
  const { item, tokenHash } = found;
  const email = String(item.email);
  const subject = String(item.subject);
  const passwordHash = await hashPassword(parsed!.password as string);
  const now = new Date().toISOString();
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: credentialKey(email),
        UpdateExpression: "SET password_hash = :hash, failed_sign_ins = :zero, locked_until = :none, password_changed_at = :now REMOVE password_reset_nonce",
        ConditionExpression: "subject = :subject AND email_verified = :verified AND password_reset_nonce = :nonce",
        ExpressionAttributeValues: {
          ":hash": passwordHash, ":zero": 0, ":none": null, ":now": now,
          ":subject": subject, ":verified": true, ":nonce": item.nonce,
        },
      } },
      consumeEmailActionUpdate(tokenHash, item, now),
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(400, { error: "invalid_or_expired_email_action" });
    }
    throw error;
  }
  await revokePasswordLoginSessions(subject);
  return response(204, null);
}

async function identityAccounts(identity: Identity): Promise<Item[]> {
  const result = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :identity",
    ExpressionAttributeValues: { ":identity": `IDENTITY#${identity.id}` },
  }));
  return (result.Items ?? []).filter((item) => item.sk === "ACCOUNT");
}

async function linkedAccounts(identity: Identity): Promise<Response> {
  const accounts = await identityAccounts(identity);
  const linked = await Promise.all(accounts.map(async (account) => {
    const provider = typeof account.platform === "string" ? account.platform : "";
    const subject = typeof account.platform_user_id === "string" ? account.platform_user_id : "";
    let verified = true;
    if (provider === passwordProviderId && typeof account.email === "string") {
      verified = (await passwordCredentials.find(account.email))?.emailVerified === true;
    }
    return {
      provider,
      subject,
      displayName: typeof account.display_name === "string" ? account.display_name : null,
      username: typeof account.username === "string" ? account.username : null,
      email: typeof account.email === "string" ? account.email : null,
      photoUrl: typeof account.photo_url === "string" ? account.photo_url : null,
      verified,
    };
  }));
  return response(200, {
    accounts: linked,
    linkableProviders: [...proofLinkProviders.keys()],
    passwordManagementAvailable: passwordLoginEnabled && emailDeliveryProvider !== "none",
  });
}

async function linkProofAccount(identity: Identity, provider: LoginProvider, event: Event): Promise<Response> {
  const attempt = objectBody(event);
  if (attempt === null) return response(400, { error: "invalid_json" });
  const principal = await authenticateWith(provider, attempt);
  if (principal === null) return response(401, { error: `invalid_or_expired_${provider.id}_login` });
  const existing = await identityAccounts(identity);
  if (existing.some((account) => account.platform === provider.id)) {
    return response(409, { error: "provider_already_linked" });
  }

  const now = new Date().toISOString();
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName,
        Key: { pk: accountKey(principal), sk: "ACCOUNT" },
        UpdateExpression: [
          "SET platform = :provider", "platform_user_id = :subject", "display_name = :displayName",
          "username = :username", "photo_url = :photoUrl", "email = :email",
          "first_seen_at = if_not_exists(first_seen_at, :now)", "last_seen_at = :now",
          "identity_id = :identityId", "#status = :linked", "linked_at = :now", "linked_by = :identityId",
          "gsi1pk = :identityIndex", "gsi1sk = :now",
        ].join(", "),
        ConditionExpression: "attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":provider": principal.provider,
          ":subject": principal.subject,
          ":displayName": principal.displayName,
          ":username": principal.username,
          ":photoUrl": principal.photoUrl,
          ":email": principal.email,
          ":now": now,
          ":identityId": identity.id,
          ":linked": "LINKED",
          ":identityIndex": `IDENTITY#${identity.id}`,
        },
      } },
      { Put: {
        TableName: tableName,
        Item: {
          pk: `IDENTITY#${identity.id}`,
          sk: `LOGIN_PROVIDER#${provider.id}`,
          entity_type: "IDENTITY_LOGIN_PROVIDER",
          provider: provider.id,
          subject: principal.subject,
          created_at: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(409, { error: "account_already_linked" });
    }
    throw error;
  }
  return response(201, { account: {
    provider: principal.provider,
    subject: principal.subject,
    displayName: principal.displayName,
    username: principal.username,
    email: principal.email,
    photoUrl: principal.photoUrl,
    verified: true,
  } });
}

function passwordCredentialItem(
  subject: string,
  email: string,
  displayName: string,
  passwordHash: string,
  action: EmailAction,
): Item {
  return {
    ...credentialKey(email),
    entity_type: "PASSWORD_CREDENTIAL",
    subject,
    email,
    email_verified: false,
    email_verification_nonce: action.nonce,
    display_name: displayName,
    password_hash: passwordHash,
    failed_sign_ins: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  };
}

function passwordAccountItem(subject: string, email: string, displayName: string, identity: Identity): Item {
  const now = new Date().toISOString();
  return {
    pk: accountKeyFor(passwordProviderId, subject),
    sk: "ACCOUNT",
    platform: passwordProviderId,
    platform_user_id: subject,
    display_name: displayName,
    username: null,
    photo_url: null,
    email,
    first_seen_at: now,
    last_seen_at: now,
    status: "APPROVED",
    identity_id: identity.id,
    approved_at: now,
    approved_by: identity.id,
    gsi1pk: `IDENTITY#${identity.id}`,
    gsi1sk: now,
  };
}

type ValidPasswordInput = Readonly<{ email: string; displayName: string; password: string }>;

function validPasswordInput(event: Event): ValidPasswordInput | Response {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = normalizeEmail(parsed.email);
  if (email === null) return response(400, { error: "invalid_email" });
  const passwordProblem = validatePassword(parsed.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const displayName = normalizeDisplayName(parsed.displayName);
  if (displayName === null) return response(400, { error: "invalid_display_name" });
  return { email, displayName, password: parsed.password as string };
}

// Registration creates an unlinked credential. Mailbox proof starts its first
// login session; only then is the account observed and eligible for the normal
// access-request flow.
async function registerPassword(event: Event): Promise<Response> {
  const input = validPasswordInput(event);
  if ("statusCode" in input) return input;
  const { email, displayName, password } = input;
  const subject = randomUUID();
  const action = issueEmailAction("verify_email");
  const credential = { subject, email, displayName };
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: passwordCredentialItem(subject, email, displayName, await hashPassword(password), action),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: emailActionItem("verify_email", action, credential),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return response(409, { error: "email_already_registered" });
    throw error;
  }
  await deliverEmailAction("verify_email", action, credential);
  return response(202, { result: "verification_sent", email });
}

async function linkPassword(identity: Identity, event: Event): Promise<Response> {
  const input = validPasswordInput(event);
  if ("statusCode" in input) return input;
  const existing = await identityAccounts(identity);
  if (existing.some((account) => account.platform === passwordProviderId)) {
    return response(409, { error: "password_account_already_linked" });
  }
  const { email, displayName, password } = input;
  const subject = randomUUID();
  const action = issueEmailAction("verify_email");
  const credential = { subject, email, displayName };
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: tableName,
        Item: passwordCredentialItem(subject, email, displayName, await hashPassword(password), action),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: passwordAccountItem(subject, email, displayName, identity),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: {
          pk: `IDENTITY#${identity.id}`,
          sk: `LOGIN_PROVIDER#${passwordProviderId}`,
          entity_type: "IDENTITY_LOGIN_PROVIDER",
          provider: passwordProviderId,
          subject,
          created_at: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: {
        TableName: tableName,
        Item: emailActionItem("verify_email", action, credential, identity.id),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      return response(409, { error: "email_already_registered" });
    }
    throw error;
  }
  await deliverEmailAction("verify_email", action, credential);
  return response(202, { result: "verification_sent", email });
}

async function changePassword(identity: Identity, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = normalizeEmail(parsed.email);
  if (email === null) return response(400, { error: "invalid_email" });
  if (typeof parsed.currentPassword !== "string") return response(400, { error: "current_password_required" });
  const passwordProblem = validatePassword(parsed.password);
  if (passwordProblem !== null) return response(400, { error: `password_${passwordProblem}` });
  const credential = await passwordCredentials.find(email);
  if (credential === null || !credential.emailVerified || !await verifyPassword(parsed.currentPassword, credential.passwordHash)) {
    return response(401, { error: "invalid_current_password" });
  }
  const linked = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: accountKeyFor(passwordProviderId, credential.subject), sk: "ACCOUNT" },
    ConsistentRead: true,
  }));
  if (linked.Item?.identity_id !== identity.id) return response(403, { error: "credential_not_linked" });
  await document.send(new UpdateCommand({
    TableName: tableName,
    Key: credentialKey(email),
    UpdateExpression: "SET password_hash = :hash, failed_sign_ins = :zero, locked_until = :none, password_changed_at = :now",
    ConditionExpression: "subject = :subject AND email_verified = :verified",
    ExpressionAttributeValues: {
      ":hash": await hashPassword(parsed.password as string),
      ":zero": 0,
      ":none": null,
      ":now": new Date().toISOString(),
      ":subject": credential.subject,
      ":verified": true,
    },
  }));
  await revokePasswordLoginSessions(credential.subject);
  return response(204, null);
}

// Which ways in this deployment offers, so the panel draws only buttons that
// lead somewhere. Public by nature: it is read before there is a session.
function loginProviders(): Response {
  return response(200, {
    providers: ["telegram", ...(passwordLoginEnabled ? [passwordProviderId] : [])],
    selfRegistration: passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none" ? [passwordProviderId] : [],
    emailActions: emailDeliveryProvider !== "none",
  });
}

const passwordLoginDisabled = (): Response => response(404, { error: "not_found" });

// The files a player needs to join, for the release the world is actually
// running. Whoever may learn where to connect may have what it takes to
// connect: the same permission covers both, rather than inventing a second one
// that would always be granted together with it.
async function packDownload(gameId: string, worldId: string): Promise<Response> {
  const worldRecord = await awsControlPlaneSources.listWorldRecords?.()
    .then((records) => records.find((record) => record.gameId === gameId && record.worldId === worldId));
  if (worldRecord === undefined) return response(404, { error: "unknown_world" });
  const choice = packRelease(await awsControlPlaneSources.readReleasePointer(
    worldId,
    worldRecord.currentGeneration.id,
  ));
  if (choice.kind === "none") return response(409, { error: choice.reason });

  const url = await packDownloadUrl(gameId, worldRecord.preset.id, choice.release);
  if (url === null) return response(409, { error: "no_pack_published", release: choice.release });
  return response(200, { release: choice.release, url, expiresIn: 3600 });
}

// What a restore would have to choose between. The inventory is read from a
// listing rather than by touching an archive, so this role cannot download a
// world even though it can say which backups exist.
async function backups(gameId: string, worldId: string): Promise<Response> {
  const legacyWorld = gameCatalog.find((game) => game.id === gameId)?.worlds.some((candidate) => candidate.id === worldId);
  if (!legacyWorld) {
    const record = await readWorldRecord(worldId);
    if (record?.gameId !== gameId) return response(404, { error: "unknown_world" });
  }
  return response(200, backupInventory(await listWorldBackups(worldId)));
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

// An account is addressed by the platform that vouches for it and that
// platform's own id: Telegram's numeric user id, a password credential's uuid.
const PLATFORM_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const PLATFORM_USER_ID = /^[A-Za-z0-9._:@-]{1,255}$/;
const withCandidateAddress = (event: Event, handle: (platform: string, platformUserId: string) => Promise<Response>): Promise<Response> | Response => {
  const platform = parameter(event, "platform");
  const platformUserId = parameter(event, "platformUserId");
  if (!PLATFORM_ID.test(platform) || !PLATFORM_USER_ID.test(platformUserId)) return response(400, { error: "invalid_account_address" });
  return handle(platform, platformUserId);
};

export const routes: Readonly<Record<string, Route>> = {
  "GET /auth/providers": publicRoute(() => loginProviders()),
  "POST /auth/telegram": publicRoute((event) => authenticate(telegramProvider, event)),
  "POST /auth/password": publicRoute((event) => (passwordLoginEnabled ? authenticate(passwordProvider, event) : passwordLoginDisabled())),
  "POST /auth/password/register": publicRoute((event) => (
    passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none"
      ? registerPassword(event)
      : passwordLoginDisabled()
  )),
  "POST /auth/email/verification": publicRoute((event) => verifyEmail(event)),
  "POST /auth/email/verification/resend": publicRoute((event) => resendEmailVerification(event)),
  "POST /auth/password/forgot": publicRoute((event) => requestPasswordReset(event)),
  "POST /auth/password/reset": publicRoute((event) => resetPassword(event)),
  "POST /auth/refresh": publicRoute((event) => refreshLoginSession(event)),
  "POST /auth/logout": publicRoute((event) => logoutLoginSession(event)),

  "GET /session": sessionRoute((account) => session(account)),
  "POST /access/request": sessionRoute(async (account) => {
    await observe(account);
    return requestAccess(account);
  }),

  "GET /me": identityRoute((identity) => me(identity)),
  "GET /me/accounts": identityRoute((identity) => linkedAccounts(identity)),
  "POST /me/accounts/{provider}": identityRoute((identity, event) => {
    const provider = proofLinkProviders.get(parameter(event, "provider"));
    return provider === undefined ? response(404, { error: "not_found" }) : linkProofAccount(identity, provider, event);
  }),
  "POST /me/password": identityRoute((identity, event) => (
    passwordLoginEnabled && emailDeliveryProvider !== "none" ? linkPassword(identity, event) : passwordLoginDisabled()
  )),
  "POST /me/password/change": identityRoute((identity, event) => (
    passwordLoginEnabled ? changePassword(identity, event) : passwordLoginDisabled()
  )),
  "GET /me/subscriptions": identityRoute((identity) => subscriptions(identity)),
  "PUT /me/subscriptions": identityRoute((identity, event) => updateSubscriptions(identity, event.body)),
  "GET /me/appearance": identityRoute((identity) => appearance(identity)),
  "PUT /me/appearance": identityRoute((identity, event) => updateAppearance(identity, event.body)),

  "GET /control-plane": permissionRoute("status.read", (identity) => controlPlane(identity)),
  "POST /control-plane/subscriptions": permissionRoute("status.read", (identity) => createControlPlaneSubscription(identity)),
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity)),
  "GET /hosts/{instanceId}/metrics": permissionRoute("metrics.read", (_identity, event) =>
    hostMetrics(parameter(event, "instanceId"), event.queryStringParameters?.range ?? "24h")),
  "GET /games/{gameId}/presets/{presetId}/releases/{version}": permissionRoute("release.read", (_identity, event) =>
    releaseManifest(parameter(event, "gameId"), parameter(event, "presetId"), parameter(event, "version"))),
  "GET /invitations/recipients": permissionRoute("invitation.send", (identity) => invitationRecipients(identity)),

  "POST /games/{gameId}/presets/{presetId}/worlds": permissionRoute("world.manage", (identity, event) =>
    createWorld(identity, parameter(event, "gameId"), parameter(event, "presetId"), event.body)),
  "PUT /games/{gameId}/worlds/{worldId}/settings": permissionRoute("world.manage", (_identity, event) =>
    updateWorldSettings(parameter(event, "gameId"), parameter(event, "worldId"), event.body)),

  "POST /games/{gameId}/worlds/{worldId}/start": permissionRoute("session.start", (identity, event) =>
    controlSession(identity, "start", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/stop": permissionRoute("session.stop", (identity, event) =>
    controlSession(identity, "stop", parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    createInvitation(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "GET /games/{gameId}/worlds/{worldId}/invitations": permissionRoute("invitation.send", (identity, event) =>
    invitationHistory(identity, parameter(event, "gameId"), parameter(event, "worldId"))),
  "GET /games/{gameId}/worlds/{worldId}/pack": permissionRoute("connection.read", (_identity, event) =>
    packDownload(parameter(event, "gameId"), parameter(event, "worldId"))),

  "GET /games/{gameId}/worlds/{worldId}/backups": permissionRoute("backup.read", (_identity, event) =>
    backups(parameter(event, "gameId"), parameter(event, "worldId"))),
  "POST /games/{gameId}/worlds/{worldId}/archive": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "archive", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/wipe": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "regenerate", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/restore": permissionRoute("backup.restore", (identity, event) =>
    controlWorldLifecycle(identity, "restore", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
  "POST /games/{gameId}/worlds/{worldId}/purge": permissionRoute("world.manage", (identity, event) =>
    controlWorldLifecycle(identity, "purge", parameter(event, "gameId"), parameter(event, "worldId"), event.body)),

  "GET /access/candidates": permissionRoute("access.manage", () => candidates()),
  "GET /access/identities": permissionRoute("access.manage", () => identities()),
  "POST /access/candidates/{platform}/{platformUserId}/approve": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => approve(identity, platform, platformUserId, event.body))),
  "POST /access/candidates/{platform}/{platformUserId}/dismiss": permissionRoute("access.manage", (identity, event) =>
    withCandidateAddress(event, (platform, platformUserId) => dismiss(identity, platform, platformUserId))),
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

  const identity = await resolveIdentity(account);
  if (identity === null) return response(403, { error: "access_not_granted" });
  if (route.access.kind === "identity") return call(identity);

  const forbidden = requirePermission(identity, route.access.permission);
  return forbidden ?? call(identity);
}
