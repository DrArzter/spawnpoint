import { type Identity, roleOf } from "../../access/domain.ts";
import { defaultSubscriptions, validateSubscriptions } from "../../access/subscriptions.ts";
import { validateAppearance, defaultAppearance } from "../../access/appearance.ts";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";
import { accessTable, tableName } from "./access-store.ts";
import { identitySettingKey } from "../../access/keys.ts";
import type { AppearancePreference, Profile, SubscriptionState } from "../../../../contract/access.ts";
import { sessionIdentity, sessionRole } from "./session.ts";

export async function subscriptions(identity: Identity): Promise<Response> {
  const stored = await accessTable.get({ TableName: tableName, Key: identitySettingKey(identity.id, "SUBSCRIPTIONS"), ConsistentRead: true });
  const body: Readonly<{ subscriptions: SubscriptionState }> = { subscriptions: { ...defaultSubscriptions(), ...stored.Item?.subscriptions as Record<string, boolean> | undefined } };
  return response(200, body);
}

export async function updateSubscriptions(identity: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const next = validateSubscriptions(parsed.subscriptions);
  if (next === null) return errorResponse(400, "invalid_subscriptions");
  await accessTable.put({ TableName: tableName, Item: {
    ...identitySettingKey(identity.id, "SUBSCRIPTIONS"), subscriptions: next, updated_at: new Date().toISOString(),
  } });
  const answer: Readonly<{ subscriptions: SubscriptionState }> = { subscriptions: next };
  return response(200, answer);
}

export async function appearance(identity: Identity): Promise<Response> {
  const stored = await accessTable.get({ TableName: tableName, Key: identitySettingKey(identity.id, "APPEARANCE"), ConsistentRead: true });
  const found = validateAppearance(stored.Item?.appearance);
  // A stored value that no longer validates is treated as no value: a palette
  // is not worth failing a sign-in over.
  const body: Readonly<{ appearance: AppearancePreference }> = { appearance: found ?? defaultAppearance() };
  return response(200, body);
}

export async function updateAppearance(identity: Identity, body: string | undefined): Promise<Response> {
  const parsed = parseJsonObject({ body });
  const next = validateAppearance(parsed.appearance);
  if (next === null) return errorResponse(400, "invalid_appearance");
  await accessTable.put({ TableName: tableName, Item: {
    ...identitySettingKey(identity.id, "APPEARANCE"), appearance: next, updated_at: new Date().toISOString(),
  } });
  const answer: Readonly<{ appearance: AppearancePreference }> = { appearance: next };
  return response(200, answer);
}

export function me(identity: Identity): Response {
  const body: Profile = { identity: sessionIdentity(identity), role: sessionRole(roleOf(identity)) };
  return response(200, body);
}
