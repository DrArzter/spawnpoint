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
import { accessInvitationTokenHash, accessInvitationUrl, accessInvitationUsable, issueAccessInvitation, renderAccessInvitationEmail, renderAccessInvitationProofEmail } from "../access/access-invitations.ts";
import { directInvitationReadiness } from "../access/invitation-readiness.ts";
import {
  browserSessionCookie,
  browserSessionCookieName,
  equalRefreshHashes,
  expiredBrowserSessionCookie,
  expiredRefreshCookie,
  issueRefreshCredential,
  parseRefreshCredential,
  refreshCookieName,
  refreshSessionLifetimeSeconds,
  trustedCookieRequest,
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
import { createGoogleLoginProvider, googleProviderId } from "../access/google-login-provider.ts";
import { defaultAppearance, validateAppearance } from "../access/appearance.ts";
import { defaultSubscriptions, validateSubscriptions } from "../access/subscriptions.ts";
import {
  credentialHash,
  issueAuthorizationRequest,
  issueOAuthAccessToken,
  issueOpaqueCredential,
  normalizeScopes,
  oauthScopes,
  oauthAccessTokenLifetimeSeconds,
  oauthAuthorizationCodeLifetimeSeconds,
  oauthRefreshTokenLifetimeSeconds,
  verifyAuthorizationRequest,
  verifyOAuthAccessToken,
  verifyPkce,
  type OAuthScope,
} from "../access/oauth.ts";
import { requestBody } from "../access/request-body.ts";
import { privateTelegramChatId, type AccessApprovedEvent } from "../domain/access-events.ts";
import type { InvitationAudience, InvitationEvent } from "../domain/invitations.ts";
import type { EmailSender } from "../email/email-sender.ts";
import { createResendEmailSender } from "../email/resend-email-sender.ts";
import { catalogWithPresets, findCatalogWorld, gameCatalog } from "../control-plane/catalog.ts";
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
  isBase64Encoded?: boolean;
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
const googleOidcClientId = (process.env.GOOGLE_OIDC_CLIENT_ID ?? "").trim();
const controlPlaneViewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!controlPlaneViewTable) throw new Error("missing environment variable: CONTROL_PLANE_VIEW_TABLE");
const controlPlaneWebSocketUrl = process.env.CONTROL_PLANE_WEBSOCKET_URL;
if (!controlPlaneWebSocketUrl) throw new Error("missing environment variable: CONTROL_PLANE_WEBSOCKET_URL");
const refreshCookieSameSite: "Strict" | "None" = process.env.REFRESH_COOKIE_SAME_SITE === "None" ? "None" : "Strict";
// A sign-in adapter is an optional capability of a deployment (ADR-0045). Off,
// its routes answer as if they were never deployed, so the panel reads them as
// not connected rather than broken.
const passwordLoginEnabled = (process.env.PASSWORD_LOGIN_ENABLED ?? "false") === "true";
// A browser provider is on exactly when its public client id exists. Telegram
// is the default only because the bot that runs the group already has one; the
// route itself stays, since the Mini App signs in through it with initData.
const telegramLoginEnabled = telegramOidcClientId !== "";
const googleLoginEnabled = googleOidcClientId !== "";
const passwordRegistrationEnabled = (process.env.PASSWORD_REGISTRATION_ENABLED ?? "false") === "true";
const emailDeliveryProvider = process.env.EMAIL_DELIVERY_PROVIDER ?? "none";
const panelUrl = (process.env.PANEL_URL ?? "").trim();
const legacyPanelUrl = (process.env.LEGACY_PANEL_URL ?? "").trim();
const apiUrl = (process.env.API_URL ?? "").trim().replace(/\/$/, "");
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const events = new EventBridgeClient({});
const ssm = new SSMClient({});
let botTokenPromise: Promise<string> | undefined;
let sessionSigningSecretPromise: Promise<string> | undefined;
let emailSenderPromise: Promise<EmailSender | null> | undefined;

function response(statusCode: number, body: unknown): Response {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: body === null ? "" : JSON.stringify(body) };
}

function responseWithHeaders(statusCode: number, body: unknown, headers: Record<string, string>): Response {
  const base = response(statusCode, body);
  return { ...base, headers: { ...base.headers, ...headers } };
}

function responseWithCookies(statusCode: number, body: unknown, cookies: string[]): Response {
  return { ...response(statusCode, body), cookies };
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
  if (match === null) return browserSessionPrincipal(event);
  const current = verifyAccessToken(match[1]!, await sessionSigningSecret())?.principal;
  if (current !== undefined) return current;
  const legacy = verifySessionToken(match[1]!, await botToken());
  return legacy === null ? null : telegramPrincipal(legacy);
}

async function browserSessionPrincipal(event: Event): Promise<LoginPrincipal | null> {
  const token = requestCookie(event, browserSessionCookieName);
  const supplied = token === null ? null : parseRefreshCredential(token);
  if (supplied === null) return null;
  const result = await document.send(new GetCommand({
    TableName: tableName,
    Key: loginSessionKey(supplied.loginSessionId),
    ConsistentRead: true,
  }));
  const item = result.Item;
  if (
    item === undefined || item.status !== "ACTIVE" ||
    typeof item.expires_at !== "number" || item.expires_at <= Math.floor(Date.now() / 1000) ||
    typeof item.token_hash !== "string" || !equalRefreshHashes(item.token_hash, supplied.tokenHash)
  ) return null;
  return principalFromLoginSession(item);
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
  accessInvitations: "GET /access/invitations",
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

function accessInvitationKey(tokenHash: string): Record<string, string> {
  return { pk: `ACCESS_INVITATION#${tokenHash}`, sk: "TOKEN" };
}

function accessInvitationProofKey(tokenHash: string, account: Caller): Record<string, string> {
  return { pk: `ACCESS_INVITATION#${tokenHash}`, sk: `PROOF#${account.provider}#${account.subject}` };
}

async function checkAccessInvitation(event: Event): Promise<Response> {
  const tokenHash = accessInvitationTokenHash(objectBody(event)?.token);
  if (tokenHash === null) return response(200, { valid: false, email: null });
  const result = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  return response(200, { valid: accessInvitationUsable(result.Item), email: accessInvitationUsable(result.Item) ? result.Item!.delivery_email : null });
}

async function accessInvitations(): Promise<Response> {
  const result = await document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :invitations",
    ExpressionAttributeValues: { ":invitations": "ACCESS_INVITATION#CREATED" },
    ScanIndexForward: false,
    Limit: 50,
  }));
  return response(200, { invitations: (result.Items ?? []).map((item) => ({
    id: item.token_hash,
    status: accessInvitationUsable(item) ? "PENDING" : item.status === "PENDING" ? "EXPIRED" : item.status,
    createdAt: item.created_at,
    expiresAt: new Date(Number(item.expires_at) * 1000).toISOString(),
    usedAt: item.used_at ?? null,
    delivery: item.delivery ?? "not_requested",
    deliveryEmail: item.delivery_email ?? null,
  })) });
}

async function createAccessInvitation(identity: Identity, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  if (parsed === null) return response(400, { error: "invalid_json" });
  const email = parsed.email === undefined ? null : normalizeEmail(parsed.email);
  if (emailDeliveryProvider === "none" && parsed.email !== undefined) return response(409, { error: "email_delivery_unavailable" });
  if (emailDeliveryProvider !== "none" && email === null) return response(400, { error: "invalid_email" });
  if (!panelUrl) return response(503, { error: "panel_url_unavailable" });
  const sender = email === null ? null : await emailSender();
  if (email !== null && sender === null) return response(409, { error: "email_delivery_unavailable" });
  const invitation = issueAccessInvitation();
  const createdAt = new Date().toISOString();
  const url = accessInvitationUrl(panelUrl, invitation.token);
  await document.send(new PutCommand({
    TableName: tableName,
    Item: {
      ...accessInvitationKey(invitation.tokenHash), entity_type: "ACCESS_INVITATION", token_hash: invitation.tokenHash,
      status: "PENDING", created_by: identity.id, created_at: createdAt,
      expires_at: invitation.expiresAtEpochSeconds, ttl: invitation.expiresAtEpochSeconds,
      delivery: email === null ? "not_requested" : "pending",
      ...(email === null ? {} : { delivery_email: email }),
      gsi1pk: "ACCESS_INVITATION#CREATED", gsi1sk: `${createdAt}#${invitation.tokenHash}`,
    },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
  let delivery = email === null ? "not_requested" : "sent";
  if (email !== null && sender !== null) {
    try {
      await sender.send(renderAccessInvitationEmail({ email, inviterName: identity.displayName, url, tokenHash: invitation.tokenHash }));
    } catch (error) {
      delivery = "failed";
      console.error("access_invitation_email_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }
    await document.send(new UpdateCommand({
      TableName: tableName, Key: accessInvitationKey(invitation.tokenHash),
      UpdateExpression: "SET delivery = :delivery",
      ExpressionAttributeValues: { ":delivery": delivery },
    }));
  }
  return response(201, { id: invitation.tokenHash, url, createdAt, expiresAt: new Date(invitation.expiresAtEpochSeconds * 1000).toISOString(), delivery });
}

async function revokeAccessInvitation(event: Event): Promise<Response> {
  const tokenHash = parameter(event, "invitationId");
  if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) return response(400, { error: "invalid_invitation_id" });
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: accessInvitationKey(tokenHash),
      UpdateExpression: "SET #status = :revoked, revoked_at = :now",
      ConditionExpression: "#status = :pending AND expires_at > :nowEpoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":revoked": "REVOKED", ":pending": "PENDING", ":now": new Date().toISOString(), ":nowEpoch": Math.floor(Date.now() / 1000) },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return response(409, { error: "invitation_unavailable" });
    throw error;
  }
  return response(204, null);
}

async function requestAccessInvitationProof(account: Caller, event: Event): Promise<Response> {
  const token = objectBody(event)?.token;
  const tokenHash = accessInvitationTokenHash(token);
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
  if (account.provider === passwordProviderId) return response(409, { error: "use_verified_account_email" });
  const observed = await observe(account);
  if (await resolveIdentity(account, observed) !== null) return response(409, { error: "already_member" });
  const found = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  if (!accessInvitationUsable(found.Item) || typeof found.Item?.delivery_email !== "string") return response(400, { error: "invalid_or_expired_invitation" });
  const sender = await emailSender();
  if (sender === null) return response(503, { error: "email_delivery_unavailable" });
  const proof = issueEmailAction("verify_email");
  const nowEpoch = Math.floor(Date.now() / 1000);
  try {
    await document.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...accessInvitationProofKey(tokenHash, account), entity_type: "ACCESS_INVITATION_PROOF",
        proof_hash: proof.tokenHash, status: "PENDING", expires_at: proof.expiresAtEpochSeconds,
        sent_at_epoch: nowEpoch, ttl: proof.expiresAtEpochSeconds,
      },
      ConditionExpression: "attribute_not_exists(pk) OR sent_at_epoch < :cutoff",
      ExpressionAttributeValues: { ":cutoff": nowEpoch - 60 },
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return response(429, { error: "proof_recently_sent" });
    throw error;
  }
  const url = `${panelUrl.replace(/\/$/, "")}/#/join?token=${encodeURIComponent(token as string)}&proof=${encodeURIComponent(proof.token)}`;
  await sender.send(renderAccessInvitationProofEmail({ email: found.Item.delivery_email, url, proofHash: proof.tokenHash }));
  return response(202, { result: "proof_sent" });
}

async function redeemAccessInvitation(account: Caller, event: Event): Promise<Response> {
  const parsed = objectBody(event);
  const tokenHash = accessInvitationTokenHash(parsed?.token);
  if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
  const observed = await observe(account);
  if (await resolveIdentity(account, observed) !== null) return response(409, { error: "already_member" });
  const found = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
  if (!accessInvitationUsable(found.Item)) return response(400, { error: "invalid_or_expired_invitation" });
  const invitedEmail = found.Item?.delivery_email;
  if (invitedEmail !== undefined && typeof invitedEmail !== "string") return response(400, { error: "invalid_or_expired_invitation" });
  const emailBound = typeof invitedEmail === "string";
  const passwordAccount = account.provider === passwordProviderId;
  if (emailBound && passwordAccount && account.email !== invitedEmail) return response(403, { error: "invited_email_mismatch" });
  const proofRequired = emailBound && !passwordAccount;
  const proofHash = proofRequired ? emailActionTokenHash(typeof parsed?.proof === "string" ? parsed.proof : "") : null;
  if (proofRequired && proofHash === null) return response(403, { error: "invited_email_verification_required" });
  const proof = proofRequired ? await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationProofKey(tokenHash, account), ConsistentRead: true })) : null;
  if (proofRequired && (proof?.Item?.proof_hash !== proofHash || proof?.Item?.status !== "PENDING" || Number(proof?.Item?.expires_at) <= Math.floor(Date.now() / 1000))) {
    return response(403, { error: "invalid_or_expired_invitation_proof" });
  }
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const name = account.displayName;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: accessInvitationKey(tokenHash),
        UpdateExpression: "SET #status = :used, used_at = :now, identity_id = :identityId",
        ConditionExpression: "#status = :pending AND expires_at > :nowEpoch",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":used": "USED", ":pending": "PENDING", ":now": now, ":identityId": identityId, ":nowEpoch": Math.floor(Date.now() / 1000) },
      } },
      ...(proofRequired && proofHash !== null ? [{ Update: {
        TableName: tableName, Key: accessInvitationProofKey(tokenHash, account),
        UpdateExpression: "SET #status = :used, used_at = :now",
        ConditionExpression: "#status = :pending AND proof_hash = :proofHash AND expires_at > :nowEpoch",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":used": "USED", ":pending": "PENDING", ":proofHash": proofHash, ":now": now, ":nowEpoch": Math.floor(Date.now() / 1000) },
      } }] : []),
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId, display_name: name,
        role_id: "viewer", direct_grants: [], status: "ACTIVE", created_at: now,
        created_by: found.Item!.created_by, gsi1pk: "IDENTITY#ACTIVE", gsi1sk: name.toLowerCase(),
      }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: {
        TableName: tableName, Key: { pk: accountKey(account), sk: "ACCOUNT" },
        UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`, ":now": now, ":by": found.Item!.created_by },
      } },
      { Put: { TableName: tableName, Item: {
        pk: `IDENTITY#${identityId}`, sk: `LOGIN_PROVIDER#${account.provider}`,
        entity_type: "IDENTITY_LOGIN_PROVIDER", provider: account.provider,
        subject: account.subject, created_at: now,
      }, ConditionExpression: "attribute_not_exists(pk)" } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return response(409, { error: "invitation_unavailable" });
    throw error;
  }
  return response(201, { identity: { id: identityId, displayName: name, roleId: "viewer", directGrants: [] } });
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

type InvitationRequest =
  | Readonly<{ ok: true; audience: InvitationAudience; recipientIdentityIds: readonly string[] }>
  | Readonly<{ ok: false; error: "invalid_json" | "invalid_audience" | "invalid_recipients" }>;

// What an invitation asks for: everyone, or the named people other than the sender.
function invitationRequest(identity: Identity, body: string | undefined): InvitationRequest {
  let parsed: { audience?: unknown; recipientIdentityIds?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return { ok: false, error: "invalid_json" }; }
  const audience = parsed.audience;
  if (audience === "broadcast") return { ok: true, audience, recipientIdentityIds: [] };
  if (audience !== "direct") return { ok: false, error: "invalid_audience" };
  const requested = parsed.recipientIdentityIds;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 100 || !requested.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))) {
    return { ok: false, error: "invalid_recipients" };
  }
  const recipientIdentityIds = [...new Set(requested as string[])].filter((id) => id !== identity.id);
  return recipientIdentityIds.length === 0 ? { ok: false, error: "invalid_recipients" } : { ok: true, audience, recipientIdentityIds };
}

async function createInvitation(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  const request = invitationRequest(identity, body);
  if (!request.ok) return response(400, { error: request.error });
  const { audience, recipientIdentityIds } = request;
  // Every world the panel lists, not only the two in the built-in catalog: a
  // world created from a preset lives in the registry (ADR-0040).
  const [presets, worldRecords] = await Promise.all([
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const found = findCatalogWorld(catalogWithPresets(presets, gameCatalog, worldRecords), gameId, worldId);
  if (found === null) return response(404, { error: "unknown_world" });
  if (found.world.materialization === "archived") return response(409, { error: "world_archived" });
  const { game, world } = found;

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
    invitationId, audience, gameId, gameName: game.displayName,
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

async function createLoginSession(principal: LoginPrincipal): Promise<Response> {
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
  return responseWithCookies(200, { authenticated: true }, [
    browserSessionCookie(credential.token, refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
}

async function refreshLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, browserSessionCookieName) ?? requestCookie(event, refreshCookieName);
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
  return responseWithCookies(200, { authenticated: true }, [
    browserSessionCookie(rotated.token, refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
}

async function logoutLoginSession(event: Event): Promise<Response> {
  const cookie = requestCookie(event, browserSessionCookieName) ?? requestCookie(event, refreshCookieName);
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
  return responseWithCookies(204, null, [
    expiredBrowserSessionCookie(refreshCookieSameSite),
    expiredRefreshCookie(refreshCookieSameSite),
  ]);
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
  return createLoginSession(principal);
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
const googleProvider = createGoogleLoginProvider({ clientId: googleOidcClientId });

// Proof-based providers all link through the same use-case. Password is kept
// separate because linking it creates a new credential and verifies a mailbox;
// Telegram, Google and Discord only need to verify a provider-owned proof.
// A provider that is off is not linkable either: the profile offers only what
// can be signed in with afterwards.
const proofLinkProviders: ReadonlyMap<string, LoginProvider> = new Map(
  [...(telegramLoginEnabled ? [telegramProvider] : []), ...(googleLoginEnabled ? [googleProvider] : [])]
    .map((provider): [string, LoginProvider] => [provider.id, provider]),
);

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
  invitationToken?: string,
): Promise<boolean> {
  const sender = await emailSender();
  if (sender === null) return false;
  await sender.send(renderEmailAction(purpose, { email: credential.email, displayName: credential.displayName, panelUrl, action, ...(invitationToken ? { invitationToken } : {}) }));
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
  const invitationToken = parsed?.invitationToken;
  if (invitationToken !== undefined) {
    const tokenHash = accessInvitationTokenHash(invitationToken);
    if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
    const invitation = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
    if (!accessInvitationUsable(invitation.Item)) return response(400, { error: "invalid_or_expired_invitation" });
    if (invitation.Item?.delivery_email !== email) return response(403, { error: "invited_email_mismatch" });
  }
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
  await deliverEmailAction("verify_email", action, credential, typeof invitationToken === "string" ? invitationToken : undefined);
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
  return createLoginSession(passwordPrincipal(credential));
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
  const invitationToken = objectBody(event)?.invitationToken;
  if (invitationToken !== undefined) {
    const tokenHash = accessInvitationTokenHash(invitationToken);
    if (tokenHash === null) return response(400, { error: "invalid_or_expired_invitation" });
    const invitation = await document.send(new GetCommand({ TableName: tableName, Key: accessInvitationKey(tokenHash), ConsistentRead: true }));
    if (!accessInvitationUsable(invitation.Item)) return response(400, { error: "invalid_or_expired_invitation" });
    if (invitation.Item?.delivery_email !== input.email) return response(403, { error: "invited_email_mismatch" });
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
        Item: emailActionItem("verify_email", action, credential),
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return response(409, { error: "email_already_registered" });
    throw error;
  }
  await deliverEmailAction("verify_email", action, credential, typeof invitationToken === "string" ? invitationToken : undefined);
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
    providers: [
      ...(telegramLoginEnabled ? [telegramProvider.id] : []),
      ...(googleLoginEnabled ? [googleProviderId] : []),
      ...(passwordLoginEnabled ? [passwordProviderId] : []),
    ],
    selfRegistration: passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none" ? [passwordProviderId] : [],
    emailActions: emailDeliveryProvider !== "none",
  });
}

const loginProviderDisabled = (): Response => response(404, { error: "not_found" });

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

// --- Remote MCP authorization and transport ---------------------------------

const oauthResource = `${apiUrl}/mcp`;
const oauthIssuer = apiUrl;
const oauthProtectedResourceMetadata = `${apiUrl}/.well-known/oauth-protected-resource/mcp`;

type OAuthClient = Readonly<{
  id: string;
  name: string;
  redirectUris: readonly string[];
}>;

function oauthClientKey(clientId: string): Record<string, string> {
  return { pk: `OAUTH#CLIENT#${clientId}`, sk: "CLIENT" };
}

function oauthCredentialKey(kind: "CODE" | "REFRESH", hash: string): Record<string, string> {
  return { pk: `OAUTH#${kind}#${hash}`, sk: kind };
}

function jsonBody(event: Event): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const value = JSON.parse(requestBody(event)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function formBody(event: Event): URLSearchParams {
  return new URLSearchParams(requestBody(event));
}

function oauthError(statusCode: number, error: string, description?: string): Response {
  return response(statusCode, { error, ...(description ? { error_description: description } : {}) });
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch { return false; }
}

async function oauthClient(clientId: string): Promise<OAuthClient | null> {
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(clientId)) return null;
  const item = (await document.send(new GetCommand({ TableName: tableName, Key: oauthClientKey(clientId), ConsistentRead: true }))).Item;
  if (item === undefined || item.status !== "ACTIVE" || typeof item.client_name !== "string" || !Array.isArray(item.redirect_uris)) return null;
  const redirectUris = item.redirect_uris.filter((uri): uri is string => typeof uri === "string");
  return { id: clientId, name: item.client_name, redirectUris };
}

async function registerOAuthClient(event: Event): Promise<Response> {
  const body = jsonBody(event);
  const name = typeof body?.client_name === "string" ? body.client_name.trim() : "";
  const redirectUris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  if (!name || name.length > 80 || redirectUris.length === 0 || redirectUris.length > 8 || redirectUris.some((uri) => !validRedirectUri(uri))) {
    return oauthError(400, "invalid_client_metadata");
  }
  if (body?.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Spawnpoint accepts public PKCE clients only.");
  }
  const clientId = `sp_${randomUUID()}`;
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthClientKey(clientId), status: "ACTIVE", client_name: name, redirect_uris: redirectUris,
    token_endpoint_auth_method: "none", created_at: new Date().toISOString(),
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return response(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

async function startOAuthAuthorization(event: Event): Promise<Response> {
  const query = event.queryStringParameters ?? {};
  const client = await oauthClient(query.client_id ?? "");
  if (client === null) return oauthError(400, "invalid_request", "Unknown OAuth client.");
  const redirectUri = query.redirect_uri ?? "";
  const scopes = normalizeScopes(query.scope ?? oauthScopes.join(" "));
  if (
    query.response_type !== "code" || !client.redirectUris.includes(redirectUri) || query.resource !== oauthResource ||
    query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? "") ||
    typeof query.state !== "string" || query.state.length < 8 || query.state.length > 1024 || scopes === null
  ) return oauthError(400, "invalid_request");
  const request = issueAuthorizationRequest({
    clientId: client.id, redirectUri, resource: oauthResource, scopes, state: query.state,
    codeChallenge: query.code_challenge!,
  }, await sessionSigningSecret());
  const location = `${panelUrl}/#/connect?request=${encodeURIComponent(request)}`;
  return responseWithHeaders(302, null, { location, "cache-control": "no-store" });
}

function oauthRedirect(redirectUri: string, values: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}

async function completeOAuthAuthorization(identity: Identity, event: Event): Promise<Response> {
  const body = jsonBody(event);
  const requestToken = typeof body?.request === "string" ? body.request : "";
  const request = verifyAuthorizationRequest(requestToken, await sessionSigningSecret());
  if (request === null) return oauthError(400, "invalid_request");
  const client = await oauthClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) return oauthError(400, "invalid_request");
  if (body?.approved !== true) {
    return response(200, { redirect_to: oauthRedirect(request.redirectUri, { error: "access_denied", state: request.state }) });
  }
  const code = issueOpaqueCredential();
  const now = Math.floor(Date.now() / 1000);
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthCredentialKey("CODE", code.hash), status: "ACTIVE", identity_id: identity.id,
    client_id: request.clientId, redirect_uri: request.redirectUri, resource: request.resource,
    scope: request.scopes.join(" "), code_challenge: request.codeChallenge,
    created_at: new Date(now * 1000).toISOString(), expires_at: now + oauthAuthorizationCodeLifetimeSeconds,
    ttl: now + oauthAuthorizationCodeLifetimeSeconds,
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return response(200, { redirect_to: oauthRedirect(request.redirectUri, { code: code.token, state: request.state, iss: oauthIssuer }) });
}

async function inspectOAuthAuthorization(event: Event): Promise<Response> {
  const body = jsonBody(event);
  const request = verifyAuthorizationRequest(typeof body?.request === "string" ? body.request : "", await sessionSigningSecret());
  if (request === null) return oauthError(400, "invalid_request");
  const client = await oauthClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) return oauthError(400, "invalid_request");
  return response(200, { client: { name: client.name, redirectOrigin: new URL(request.redirectUri).origin }, scopes: request.scopes });
}

async function issueOAuthTokens(subject: { identityId: string; clientId: string; resource: string; scopes: readonly OAuthScope[] }): Promise<Response> {
  const secret = await sessionSigningSecret();
  const refresh = issueOpaqueCredential();
  const now = Math.floor(Date.now() / 1000);
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...oauthCredentialKey("REFRESH", refresh.hash), status: "ACTIVE", identity_id: subject.identityId,
    client_id: subject.clientId, resource: subject.resource, scope: subject.scopes.join(" "),
    created_at: new Date(now * 1000).toISOString(), expires_at: now + oauthRefreshTokenLifetimeSeconds,
    ttl: now + oauthRefreshTokenLifetimeSeconds,
  }, ConditionExpression: "attribute_not_exists(pk)" }));
  return responseWithHeaders(200, {
    access_token: issueOAuthAccessToken({
      identityId: subject.identityId, clientId: subject.clientId, audience: subject.resource, scopes: subject.scopes,
    }, oauthIssuer, secret, now),
    token_type: "Bearer", expires_in: oauthAccessTokenLifetimeSeconds,
    refresh_token: refresh.token, scope: subject.scopes.join(" "),
  }, { "cache-control": "no-store", pragma: "no-cache" });
}

async function exchangeAuthorizationCode(params: URLSearchParams): Promise<Response> {
  const code = params.get("code") ?? "";
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: oauthCredentialKey("CODE", credentialHash(code)), ConsistentRead: true,
  }))).Item;
  const now = Math.floor(Date.now() / 1000);
  if (
    item?.status !== "ACTIVE" || typeof item.expires_at !== "number" || item.expires_at <= now ||
    item.client_id !== params.get("client_id") || item.redirect_uri !== params.get("redirect_uri") ||
    item.resource !== params.get("resource") || typeof item.code_challenge !== "string" || !verifyPkce(params.get("code_verifier") ?? "", item.code_challenge) ||
    typeof item.identity_id !== "string" || typeof item.client_id !== "string" || typeof item.resource !== "string" || typeof item.scope !== "string"
  ) return oauthError(400, "invalid_grant");
  const scopes = normalizeScopes(item.scope);
  if (scopes === null) return oauthError(400, "invalid_grant");
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: oauthCredentialKey("CODE", credentialHash(code)),
      UpdateExpression: "SET #status = :used, used_at = :now",
      ConditionExpression: "#status = :active AND expires_at > :epoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":used": "USED", ":active": "ACTIVE", ":now": new Date().toISOString(), ":epoch": now },
    }));
  } catch { return oauthError(400, "invalid_grant"); }
  return issueOAuthTokens({ identityId: item.identity_id, clientId: item.client_id, resource: item.resource, scopes });
}

async function rotateRefreshToken(params: URLSearchParams): Promise<Response> {
  const token = params.get("refresh_token") ?? "";
  const hash = credentialHash(token);
  const requestedResource = params.get("resource");
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: oauthCredentialKey("REFRESH", hash), ConsistentRead: true,
  }))).Item;
  const now = Math.floor(Date.now() / 1000);
  if (
    item?.status !== "ACTIVE" || typeof item.expires_at !== "number" || item.expires_at <= now ||
    item.client_id !== params.get("client_id") || (requestedResource !== null && item.resource !== requestedResource) ||
    typeof item.identity_id !== "string" || typeof item.client_id !== "string" || typeof item.resource !== "string" || typeof item.scope !== "string"
  ) return oauthError(400, "invalid_grant");
  const scopes = normalizeScopes(item.scope);
  if (scopes === null) return oauthError(400, "invalid_grant");
  try {
    await document.send(new UpdateCommand({
      TableName: tableName, Key: oauthCredentialKey("REFRESH", hash),
      UpdateExpression: "SET #status = :rotated, rotated_at = :now",
      ConditionExpression: "#status = :active AND expires_at > :epoch",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":rotated": "ROTATED", ":active": "ACTIVE", ":now": new Date().toISOString(), ":epoch": now },
    }));
  } catch { return oauthError(400, "invalid_grant"); }
  return issueOAuthTokens({ identityId: item.identity_id, clientId: item.client_id, resource: item.resource, scopes });
}

async function oauthToken(event: Event): Promise<Response> {
  const params = formBody(event);
  const grant = params.get("grant_type");
  if (grant === "authorization_code") return exchangeAuthorizationCode(params);
  if (grant === "refresh_token") return rotateRefreshToken(params);
  return oauthError(400, "unsupported_grant_type");
}

async function revokeOAuthToken(event: Event): Promise<Response> {
  const params = formBody(event);
  const token = params.get("token") ?? "";
  const clientId = params.get("client_id") ?? "";
  const key = oauthCredentialKey("REFRESH", credentialHash(token));
  const item = (await document.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;
  if (item?.client_id === clientId && item.status === "ACTIVE") {
    try {
      await document.send(new UpdateCommand({
        TableName: tableName, Key: key,
        UpdateExpression: "SET #status = :revoked, revoked_at = :now",
        ConditionExpression: "#status = :active AND client_id = :client",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "REVOKED", ":active": "ACTIVE", ":client": clientId, ":now": new Date().toISOString() },
      }));
    } catch { /* Revocation is deliberately idempotent and enumeration-safe. */ }
  }
  return responseWithHeaders(200, null, { "cache-control": "no-store" });
}

function oauthServerMetadata(): Response {
  return response(200, {
    issuer: oauthIssuer,
    authorization_endpoint: `${oauthIssuer}/oauth/authorize`,
    token_endpoint: `${oauthIssuer}/oauth/token`,
    revocation_endpoint: `${oauthIssuer}/oauth/revoke`,
    registration_endpoint: `${oauthIssuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: oauthScopes,
  });
}

function oauthResourceMetadata(): Response {
  return response(200, { resource: oauthResource, authorization_servers: [oauthIssuer], scopes_supported: oauthScopes });
}

async function identityById(identityId: string): Promise<Identity | null> {
  const item = (await document.send(new GetCommand({
    TableName: tableName, Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" }, ConsistentRead: true,
  }))).Item;
  return item === undefined || item.status !== "ACTIVE" ? null : identityFromItem(item);
}

type McpRequest = Readonly<{ jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }>;

const mcpTools = [
  { name: "get_profile", title: "Get Spawnpoint profile", description: "Read the connected Spawnpoint identity and role.", permission: null, scope: "spawnpoint.read", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true },
  { name: "get_control_plane", title: "Get Spawnpoint control plane", description: "List games, worlds, sessions, hosts, releases, permissions, and current state.", permission: "status.read", scope: "spawnpoint.read", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true },
  { name: "get_host_metrics", title: "Get host metrics", description: "Read recent metrics for one host.", permission: "metrics.read", scope: "spawnpoint.read", inputSchema: { type: "object", properties: { instanceId: { type: "string" }, range: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "24h" } }, required: ["instanceId"], additionalProperties: false }, readOnly: true },
  { name: "list_world_backups", title: "List world backups", description: "List recoverable backups for one world.", permission: "backup.read", scope: "spawnpoint.read", inputSchema: { type: "object", properties: { gameId: { type: "string" }, worldId: { type: "string" } }, required: ["gameId", "worldId"], additionalProperties: false }, readOnly: true },
  { name: "get_world_pack", title: "Get world client pack", description: "Create a temporary download link for the world's client pack.", permission: "connection.read", scope: "spawnpoint.read", inputSchema: { type: "object", properties: { gameId: { type: "string" }, worldId: { type: "string" } }, required: ["gameId", "worldId"], additionalProperties: false }, readOnly: true },
  { name: "start_world", title: "Start world", description: "Request that Spawnpoint start one world.", permission: "session.start", scope: "spawnpoint.operate", inputSchema: { type: "object", properties: { gameId: { type: "string" }, worldId: { type: "string" } }, required: ["gameId", "worldId"], additionalProperties: false }, readOnly: false },
  { name: "stop_world", title: "Stop world", description: "Request a verified backup and stop for one world.", permission: "session.stop", scope: "spawnpoint.operate", inputSchema: { type: "object", properties: { gameId: { type: "string" }, worldId: { type: "string" } }, required: ["gameId", "worldId"], additionalProperties: false }, readOnly: false },
] as const satisfies readonly { name: string; title: string; description: string; permission: Permission | null; scope: OAuthScope; inputSchema: Record<string, unknown>; readOnly: boolean }[];

function mcpJson(id: unknown, result: unknown): Response {
  return response(200, { jsonrpc: "2.0", id, result });
}

function mcpError(id: unknown, code: number, message: string): Response {
  return response(200, { jsonrpc: "2.0", id, error: { code, message } });
}

function mcpResult(data: unknown): Record<string, unknown> {
  return { structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function mcpToolError(message: string): Response {
  return response(200, { ...mcpResult({ error: message }), isError: true });
}

function hasMcpToolPermission(identity: Identity, permission: Permission | null): boolean {
  if (permission === null) return true;
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission);
}

function worldToolArguments(args: Record<string, unknown>): readonly [string, string] | null {
  return typeof args.gameId === "string" && args.gameId.length > 0 && typeof args.worldId === "string" && args.worldId.length > 0
    ? [args.gameId, args.worldId]
    : null;
}

function metricsToolArguments(args: Record<string, unknown>): readonly [string, string] | null {
  const range = args.range ?? "24h";
  return typeof args.instanceId === "string" && typeof range === "string" && ["1h", "6h", "24h", "7d"].includes(range)
    ? [args.instanceId, range]
    : null;
}

async function invokeMcpTool(identity: Identity, name: string, args: Record<string, unknown>): Promise<Response | null> {
  if (name === "get_profile") {
    const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
    const profile = { id: identity.id, name: identity.displayName, role: role?.name ?? identity.roleId, permissions: role?.permissions ?? identity.directGrants };
    return response(200, { structuredContent: profile, content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] });
  }
  if (name === "get_control_plane") return controlPlane(identity);
  if (name === "get_host_metrics") {
    const metricsArgs = metricsToolArguments(args);
    return metricsArgs === null ? null : hostMetrics(...metricsArgs);
  }
  const worldArgs = worldToolArguments(args);
  if (worldArgs === null) return null;
  if (name === "list_world_backups") return backups(...worldArgs);
  if (name === "get_world_pack") return packDownload(...worldArgs);
  if (name === "start_world") return controlSession(identity, "start", ...worldArgs);
  return controlSession(identity, "stop", ...worldArgs);
}

async function callMcpTool(identity: Identity, scopes: readonly OAuthScope[], name: string, args: Record<string, unknown>): Promise<Response> {
  const tool = mcpTools.find((candidate) => candidate.name === name);
  if (tool === undefined) return mcpToolError(`Unknown tool: ${name}`);
  if (!scopes.includes(tool.scope)) return response(403, { error: "insufficient_scope" });
  if (!hasMcpToolPermission(identity, tool.permission)) return response(403, { error: "forbidden" });
  const apiResponse = await invokeMcpTool(identity, name, args);
  if (apiResponse === null) return mcpToolError("Invalid tool arguments");
  const data = JSON.parse(apiResponse.body || "null") as unknown;
  return apiResponse.statusCode >= 200 && apiResponse.statusCode < 300
    ? response(200, mcpResult(data))
    : response(200, { ...mcpResult(data), isError: true });
}

function mcpUnauthorized(): Response {
  return responseWithHeaders(401, { error: "invalid_token" }, {
    "www-authenticate": `Bearer resource_metadata="${oauthProtectedResourceMetadata}"`,
  });
}

async function authenticateRemoteMcp(event: Event): Promise<Readonly<{ identity: Identity; scopes: readonly OAuthScope[] }> | null> {
  const authorization = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1] ?? "";
  const bearer = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization)?.[1];
  const subject = bearer ? verifyOAuthAccessToken(bearer, oauthIssuer, oauthResource, await sessionSigningSecret()) : null;
  if (subject === null) return null;
  const identity = await identityById(subject.identityId);
  return identity === null ? null : { identity, scopes: subject.scopes };
}

function initializeMcp(request: McpRequest): Response {
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const requestedVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
  const protocolVersion = ["2025-11-25", "2025-06-18", "2025-03-26"].includes(requestedVersion) ? requestedVersion : "2025-11-25";
  return mcpJson(request.id, {
    protocolVersion, capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "spawnpoint", version: "0.2.0" },
    instructions: "Read current state before changing a world. Operations are asynchronous and remain subject to Spawnpoint permissions.",
  });
}

function listMcpTools(id: unknown): Response {
  return mcpJson(id, { tools: mcpTools.map((tool) => ({
    name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }],
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [tool.scope] }], ...(tool.name === "get_profile" ? { "openai/profile": true } : {}) },
  })) });
}

async function callRemoteMcpTool(request: McpRequest, identity: Identity, scopes: readonly OAuthScope[]): Promise<Response> {
  const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const args = params.arguments !== null && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  const name = typeof params.name === "string" ? params.name : "";
  const called = await callMcpTool(identity, scopes, name, args);
  const payload = JSON.parse(called.body || "null") as unknown;
  return called.statusCode === 200 ? mcpJson(request.id, payload) : mcpJson(request.id, { ...mcpResult(payload), isError: true });
}

async function remoteMcp(event: Event): Promise<Response> {
  const authenticated = await authenticateRemoteMcp(event);
  if (authenticated === null) return mcpUnauthorized();
  const request = jsonBody(event) as McpRequest | null;
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") return mcpError(request?.id ?? null, -32600, "Invalid Request");
  if (request.method === "notifications/initialized") return { statusCode: 202, headers: {}, body: "" };
  if (request.method === "initialize") return initializeMcp(request);
  if (request.method === "tools/list") return listMcpTools(request.id);
  if (request.method === "tools/call") return callRemoteMcpTool(request, authenticated.identity, authenticated.scopes);
  return mcpError(request.id, -32601, "Method not found");
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
  "GET /.well-known/oauth-protected-resource": publicRoute(() => oauthResourceMetadata()),
  "GET /.well-known/oauth-protected-resource/mcp": publicRoute(() => oauthResourceMetadata()),
  "GET /.well-known/oauth-authorization-server": publicRoute(() => oauthServerMetadata()),
  "POST /oauth/register": publicRoute((event) => registerOAuthClient(event)),
  "GET /oauth/authorize": publicRoute((event) => startOAuthAuthorization(event)),
  "POST /oauth/token": publicRoute((event) => oauthToken(event)),
  "POST /oauth/revoke": publicRoute((event) => revokeOAuthToken(event)),
  "POST /oauth/authorize/inspect": identityRoute((_identity, event) => inspectOAuthAuthorization(event)),
  "POST /oauth/authorize": identityRoute((identity, event) => completeOAuthAuthorization(identity, event)),
  "POST /mcp": publicRoute((event) => remoteMcp(event)),
  "GET /auth/providers": publicRoute(() => loginProviders()),
  "POST /auth/telegram": publicRoute((event) => authenticate(telegramProvider, event)),
  "POST /auth/google": publicRoute((event) => (googleLoginEnabled ? authenticate(googleProvider, event) : loginProviderDisabled())),
  "POST /auth/password": publicRoute((event) => (passwordLoginEnabled ? authenticate(passwordProvider, event) : loginProviderDisabled())),
  "POST /auth/password/register": publicRoute((event) => (
    passwordLoginEnabled && passwordRegistrationEnabled && emailDeliveryProvider !== "none"
      ? registerPassword(event)
      : loginProviderDisabled()
  )),
  "POST /auth/email/verification": publicRoute((event) => verifyEmail(event)),
  "POST /auth/email/verification/resend": publicRoute((event) => resendEmailVerification(event)),
  "POST /auth/password/forgot": publicRoute((event) => requestPasswordReset(event)),
  "POST /auth/password/reset": publicRoute((event) => resetPassword(event)),
  "POST /auth/refresh": publicRoute((event) => refreshLoginSession(event)),
  "POST /auth/logout": publicRoute((event) => logoutLoginSession(event)),
  "POST /auth/access-invitations/check": publicRoute((event) => checkAccessInvitation(event)),

  "GET /session": sessionRoute((account) => session(account)),
  "POST /access/request": sessionRoute(async (account) => {
    await observe(account);
    return requestAccess(account);
  }),
  "POST /access/invitations/redeem": sessionRoute((account, event) => redeemAccessInvitation(account, event)),
  "POST /access/invitations/proof": sessionRoute((account, event) => requestAccessInvitationProof(account, event)),

  "GET /me": identityRoute((identity) => me(identity)),
  "GET /me/accounts": identityRoute((identity) => linkedAccounts(identity)),
  "POST /me/accounts/{provider}": identityRoute((identity, event) => {
    const provider = proofLinkProviders.get(parameter(event, "provider"));
    return provider === undefined ? response(404, { error: "not_found" }) : linkProofAccount(identity, provider, event);
  }),
  "POST /me/password": identityRoute((identity, event) => (
    passwordLoginEnabled && emailDeliveryProvider !== "none" ? linkPassword(identity, event) : loginProviderDisabled()
  )),
  "POST /me/password/change": identityRoute((identity, event) => (
    passwordLoginEnabled ? changePassword(identity, event) : loginProviderDisabled()
  )),
  "GET /me/subscriptions": identityRoute((identity) => subscriptions(identity)),
  "PUT /me/subscriptions": identityRoute((identity, event) => updateSubscriptions(identity, event.body)),
  "GET /me/appearance": identityRoute((identity) => appearance(identity)),
  "PUT /me/appearance": identityRoute((identity, event) => updateAppearance(identity, event.body)),

  "GET /control-plane": permissionRoute("status.read", (identity) => controlPlane(identity)),
  "POST /control-plane/subscriptions": permissionRoute("status.read", (identity) => createControlPlaneSubscription(identity)),
  "GET /access/roles": permissionRoute("access.read", (identity) => roles(identity)),
  "GET /access/invitations": permissionRoute("access.invite", () => accessInvitations()),
  "POST /access/invitations": permissionRoute("access.invite", (identity, event) => createAccessInvitation(identity, event)),
  "POST /access/invitations/{invitationId}/revoke": permissionRoute("access.invite", (_identity, event) => revokeAccessInvitation(event)),
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

  // Cookies are sent automatically, including with SameSite=None on the
  // legacy CloudFront domain. A credential-bearing write must originate from
  // one of the two configured panel origins, even when CORS would hide its
  // response from another site.
  const hasCookie = requestCookie(event, browserSessionCookieName) !== null || requestCookie(event, refreshCookieName) !== null;
  const origin = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "origin")?.[1];
  if (!trustedCookieRequest(routeKey.split(" ", 1)[0]!, hasCookie, origin, [panelUrl, legacyPanelUrl].filter(Boolean))) {
    return response(403, { error: "untrusted_origin" });
  }

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
