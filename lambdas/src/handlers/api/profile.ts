import { type Identity, isBuiltInRoleId, builtInRoles } from "../../access/domain.ts";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { defaultSubscriptions, validateSubscriptions } from "../../access/subscriptions.ts";
import { validateAppearance, defaultAppearance } from "../../access/appearance.ts";
import { type Response, response } from "./http.ts";
import { document, tableName } from "./access-store.ts";

export async function subscriptions(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: { pk: `IDENTITY#${identity.id}`, sk: "SUBSCRIPTIONS" }, ConsistentRead: true }));
  return response(200, { subscriptions: { ...defaultSubscriptions(), ...stored.Item?.subscriptions as Record<string, boolean> | undefined } });
}

export async function updateSubscriptions(identity: Identity, body: string | undefined): Promise<Response> {
  let parsed: { subscriptions?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const next = validateSubscriptions(parsed.subscriptions);
  if (next === null) return response(400, { error: "invalid_subscriptions" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `IDENTITY#${identity.id}`, sk: "SUBSCRIPTIONS", subscriptions: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { subscriptions: next });
}

export async function appearance(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: { pk: `IDENTITY#${identity.id}`, sk: "APPEARANCE" }, ConsistentRead: true }));
  const found = validateAppearance(stored.Item?.appearance);
  // A stored value that no longer validates is treated as no value: a palette
  // is not worth failing a sign-in over.
  return response(200, { appearance: found ?? defaultAppearance() });
}

export async function updateAppearance(identity: Identity, body: string | undefined): Promise<Response> {
  let parsed: { appearance?: unknown };
  try { parsed = body ? JSON.parse(body) as typeof parsed : {}; } catch { return response(400, { error: "invalid_json" }); }
  const next = validateAppearance(parsed.appearance);
  if (next === null) return response(400, { error: "invalid_appearance" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    pk: `IDENTITY#${identity.id}`, sk: "APPEARANCE", appearance: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { appearance: next });
}

export function me(identity: Identity): Response {
  const role = isBuiltInRoleId(identity.roleId) ? builtInRoles[identity.roleId] : null;
  return response(200, { identity, role });
}
