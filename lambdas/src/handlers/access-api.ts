import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import {
  builtInRoles,
  hasPermission,
  Identity,
  isBuiltInRoleId,
  normalizeVerifiedEmail,
  Permission,
  permissions,
} from "../access/domain.ts";

type JwtClaims = Record<string, unknown>;
type Event = Readonly<{
  requestContext?: { http?: { method?: string }; authorizer?: { jwt?: { claims?: JwtClaims } } };
  rawPath?: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
}>;

type Response = Readonly<{ statusCode: number; headers: Record<string, string>; body: string }>;
type Item = Record<string, unknown>;

const tableName = process.env.ACCESS_TABLE_NAME;
if (!tableName) throw new Error("missing environment variable: ACCESS_TABLE_NAME");
const bootstrapOwnerEmail = (process.env.BOOTSTRAP_OWNER_EMAIL ?? "").trim().toLowerCase();
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function response(statusCode: number, body: unknown): Response {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

function claims(event: Event): JwtClaims | null {
  return event.requestContext?.authorizer?.jwt?.claims ?? null;
}

function identityFromItem(item: Item): Identity {
  return {
    id: String(item.identity_id),
    displayName: String(item.display_name),
    roleId: String(item.role_id),
    directGrants: Array.isArray(item.direct_grants) ? item.direct_grants as Permission[] : [],
  };
}

async function linkedIdentity(subject: string): Promise<Identity | null> {
  const link = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COGNITO#${subject}`, sk: "ACCOUNT" },
  }));
  const identityId = link.Item?.identity_id;
  if (typeof identityId !== "string") return null;
  const profile = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `IDENTITY#${identityId}`, sk: "PROFILE" },
  }));
  return profile.Item === undefined ? null : identityFromItem(profile.Item);
}

async function bootstrapOwner(jwtClaims: JwtClaims): Promise<Identity | null> {
  const subject = typeof jwtClaims.sub === "string" ? jwtClaims.sub : "";
  const email = normalizeVerifiedEmail(jwtClaims);
  if (subject === "" || email === null || bootstrapOwnerEmail === "" || email !== bootstrapOwnerEmail) return null;
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const displayName = typeof jwtClaims.name === "string" && jwtClaims.name.trim() !== ""
    ? jwtClaims.name.trim()
    : email.split("@")[0]!;
  try {
    await document.send(new TransactWriteCommand({ TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: "SYSTEM", sk: "BOOTSTRAP", status: "CLAIMED", identity_id: identityId,
            claimed_at: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId,
            display_name: displayName, role_id: "owner", direct_grants: [], status: "ACTIVE",
            created_at: now, created_by: "bootstrap", gsi1pk: "IDENTITY#ACTIVE", gsi1sk: displayName.toLowerCase(),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `COGNITO#${subject}`, sk: "ACCOUNT", platform: "cognito", platform_user_id: subject,
            identity_id: identityId, email, linked_at: now,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ] }));
  } catch {
    return linkedIdentity(subject);
  }
  return { id: identityId, displayName, roleId: "owner", directGrants: [] };
}

async function caller(event: Event): Promise<Identity | null> {
  const jwtClaims = claims(event);
  const subject = typeof jwtClaims?.sub === "string" ? jwtClaims.sub : "";
  if (jwtClaims === null || subject === "" || jwtClaims.token_use !== "id") return null;
  return await linkedIdentity(subject) ?? bootstrapOwner(jwtClaims);
}

function requirePermission(identity: Identity, permission: Permission): Response | null {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : undefined;
  return role !== undefined && hasPermission(identity, role, permission)
    ? null
    : response(403, { error: "forbidden" });
}

async function candidates(): Promise<Response> {
  const states = ["CANDIDATE#REQUESTED", "CANDIDATE#OBSERVED"];
  const pages = await Promise.all(states.map((state) => document.send(new QueryCommand({
    TableName: tableName,
    IndexName: "gsi1",
    KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": state },
    ScanIndexForward: false,
  }))));
  const items = pages.flatMap((page) => page.Items ?? []).map((item) => ({
    platform: item.platform,
    platformUserId: item.platform_user_id,
    displayName: item.display_name,
    username: item.username,
    status: item.status,
    firstSeenAt: item.first_seen_at,
    lastSeenAt: item.last_seen_at,
    requestedAt: item.requested_at,
  }));
  return response(200, { candidates: items });
}

async function approve(identity: Identity, telegramId: string, body: string | undefined): Promise<Response> {
  let parsed: { roleId?: unknown; directGrants?: unknown };
  try {
    parsed = body ? JSON.parse(body) as typeof parsed : {};
  } catch {
    return response(400, { error: "invalid_json" });
  }
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
  const candidate = await document.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
  }));
  if (candidate.Item === undefined || candidate.Item.identity_id !== undefined) {
    return response(409, { error: "candidate_unavailable" });
  }
  const identityId = randomUUID();
  const now = new Date().toISOString();
  const displayName = String(candidate.Item.display_name ?? telegramId);
  await document.send(new TransactWriteCommand({ TransactItems: [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: `IDENTITY#${identityId}`, sk: "PROFILE", identity_id: identityId,
          display_name: displayName, role_id: roleId, direct_grants: directGrants, status: "ACTIVE",
          created_at: now, created_by: identity.id, gsi1pk: "IDENTITY#ACTIVE", gsi1sk: displayName.toLowerCase(),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
    {
      Update: {
        TableName: tableName,
        Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
        UpdateExpression: "SET identity_id = :identityId, #status = :approved, gsi1pk = :linked, gsi1sk = :now, approved_at = :now, approved_by = :by",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":identityId": identityId, ":approved": "APPROVED", ":linked": `IDENTITY#${identityId}`,
          ":now": now, ":by": identity.id,
        },
      },
    },
  ] }));
  return response(201, { identity: { id: identityId, displayName, roleId, directGrants } });
}

async function dismiss(identity: Identity, telegramId: string): Promise<Response> {
  const now = new Date().toISOString();
  await document.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `TELEGRAM#${telegramId}`, sk: "ACCOUNT" },
    UpdateExpression: "SET #status = :dismissed, gsi1pk = :state, gsi1sk = :now, dismissed_at = :now, dismissed_by = :by",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(identity_id)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":dismissed": "DISMISSED", ":state": "CANDIDATE#DISMISSED", ":now": now, ":by": identity.id,
    },
  }));
  return response(204, null);
}

export async function handler(event: Event): Promise<Response> {
  const identity = await caller(event);
  if (identity === null) return response(403, { error: "access_not_granted" });
  const method = event.requestContext?.http?.method ?? "";
  const path = event.rawPath ?? "";
  if (method === "GET" && path === "/me") {
    const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
    return response(200, { identity, role });
  }
  const forbidden = requirePermission(identity, "access.manage");
  if (forbidden !== null) return forbidden;
  if (method === "GET" && path === "/access/candidates") return candidates();
  const telegramId = event.pathParameters?.telegramId;
  if (telegramId !== undefined && !/^\d+$/.test(telegramId)) return response(400, { error: "invalid_telegram_id" });
  if (method === "POST" && path.endsWith("/approve") && telegramId !== undefined) {
    return approve(identity, telegramId, event.body);
  }
  if (method === "POST" && path.endsWith("/dismiss") && telegramId !== undefined) {
    return dismiss(identity, telegramId);
  }
  return response(404, { error: "not_found" });
}
