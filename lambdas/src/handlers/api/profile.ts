import { type Identity, roleOf } from "../../access/domain.ts";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { defaultSubscriptions, validateSubscriptions } from "../../access/subscriptions.ts";
import { validateAppearance, defaultAppearance } from "../../access/appearance.ts";
import { type Response, response, parseJsonObject } from "./http.ts";
import { document, tableName } from "./access-store.ts";
import { identitySettingKey } from "../../access/keys.ts";

export async function subscriptions(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: identitySettingKey(identity.id, "SUBSCRIPTIONS"), ConsistentRead: true }));
  return response(200, { subscriptions: { ...defaultSubscriptions(), ...stored.Item?.subscriptions as Record<string, boolean> | undefined } });
}

export async function updateSubscriptions(identity: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const next = validateSubscriptions(parsed.subscriptions);
  if (next === null) return response(400, { error: "invalid_subscriptions" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...identitySettingKey(identity.id, "SUBSCRIPTIONS"), subscriptions: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { subscriptions: next });
}

export async function appearance(identity: Identity): Promise<Response> {
  const stored = await document.send(new GetCommand({ TableName: tableName, Key: identitySettingKey(identity.id, "APPEARANCE"), ConsistentRead: true }));
  const found = validateAppearance(stored.Item?.appearance);
  // A stored value that no longer validates is treated as no value: a palette
  // is not worth failing a sign-in over.
  return response(200, { appearance: found ?? defaultAppearance() });
}

export async function updateAppearance(identity: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const next = validateAppearance(parsed.appearance);
  if (next === null) return response(400, { error: "invalid_appearance" });
  await document.send(new PutCommand({ TableName: tableName, Item: {
    ...identitySettingKey(identity.id, "APPEARANCE"), appearance: next, updated_at: new Date().toISOString(),
  } }));
  return response(200, { appearance: next });
}

export function me(identity: Identity): Response {
  return response(200, { identity, role: roleOf(identity) });
}
