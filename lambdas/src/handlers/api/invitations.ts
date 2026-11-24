import { type Identity } from "../../access/domain.ts";
import { directInvitationReadiness } from "../../access/invitation-readiness.ts";
import { type InvitationAudience, type InvitationEvent } from "../../domain/invitations.ts";
import { awsControlPlaneSources } from "../../control-plane/aws.ts";
import { findCatalogWorld, catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";
import { randomUUID } from "node:crypto";
import { type Response, response, parseJsonObject, errorResponse } from "./http.ts";
import { accessTable, tableName } from "./access-store.ts";
import { publishEvent } from "./aws-events.ts";
import { accessIndexName, activeIdentityIndex, identityIndex, identitySettingKey, playerInvitationKey, playerInvitationSenderIndex, profileKey } from "../../access/keys.ts";
import type { InvitationRecipient, InvitationSummary } from "../../../../contract/access.ts";

export async function invitationRecipients(identity: Identity): Promise<Response> {
  const profiles = await accessTable.query({
    TableName: tableName,
    IndexName: accessIndexName,
    KeyConditionExpression: "gsi1pk = :state",
    ExpressionAttributeValues: { ":state": activeIdentityIndex },
  });
  const candidates = (profiles.Items ?? []).filter((profile) => profile.identity_id !== identity.id);
  const recipients = await Promise.all(candidates.map(async (profile): Promise<InvitationRecipient> => {
    const identityId = String(profile.identity_id);
    const subscriptions = await accessTable.get({
      TableName: tableName,
      Key: identitySettingKey(identityId, "SUBSCRIPTIONS"),
      ConsistentRead: true,
    });
    const subscriptionMap = subscriptions.Item?.subscriptions;
    const directEnabled = subscriptionMap !== null && typeof subscriptionMap === "object"
      && (subscriptionMap as Record<string, unknown>)["invitation.direct"] === true;
    const accounts = directEnabled ? await accessTable.query({
      TableName: tableName,
      IndexName: accessIndexName,
      KeyConditionExpression: "gsi1pk = :identity",
      ExpressionAttributeValues: { ":identity": identityIndex(identityId) },
    }) : { Items: [] };
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
  | Readonly<{ ok: false; error: "invalid_audience" | "invalid_recipients" }>;

// What an invitation asks for: everyone, or the named people other than the sender.
function invitationRequest(identity: Identity, body: string | undefined): InvitationRequest {
  const parsed = parseJsonObject({ body });
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

export async function createInvitation(identity: Identity, gameId: string, worldId: string, body: string | undefined): Promise<Response> {
  const request = invitationRequest(identity, body);
  if (!request.ok) return errorResponse(400, request.error);
  const { audience, recipientIdentityIds } = request;
  // Every world the panel lists, not only the two in the built-in catalog: a
  // world created from a preset lives in the registry (ADR-0040).
  const [presets, worldRecords] = await Promise.all([
    awsControlPlaneSources.listPresets?.() ?? Promise.resolve([]),
    awsControlPlaneSources.listWorldRecords?.() ?? Promise.resolve([]),
  ]);
  const found = findCatalogWorld(catalogWithPresets(presets, gameCatalog, worldRecords), gameId, worldId);
  if (found === null) return errorResponse(404, "unknown_world");
  if (found.world.materialization === "archived") return errorResponse(409, "world_archived");
  const { game, world } = found;

  if (audience === "direct") {
    const profiles = await Promise.all(recipientIdentityIds.map((id) => accessTable.get({
      TableName: tableName, Key: profileKey(id), ProjectionExpression: "identity_id, #status",
      ExpressionAttributeNames: { "#status": "status" },
    })));
    if (profiles.some((profile) => profile.Item?.status !== "ACTIVE")) return errorResponse(400, "invalid_recipients");
  }

  const invitationId = randomUUID();
  const now = new Date().toISOString();
  const detail: InvitationEvent = {
    invitationId, audience, gameId, gameName: game.displayName,
    worldId, worldName: world.displayName, senderIdentityId: identity.id,
    senderDisplayName: identity.displayName, recipientIdentityIds,
  };
  await accessTable.put({ TableName: tableName, Item: {
    ...playerInvitationKey(invitationId), invitation_id: invitationId, audience,
    game_id: gameId, world_id: worldId, sender_identity_id: identity.id,
    recipient_identity_ids: recipientIdentityIds, status: "READY", created_at: now, published_at: now,
    gsi1pk: playerInvitationSenderIndex(identity.id, gameId, worldId), gsi1sk: `${now}#${invitationId}`,
  } });
  const refused = await publishEvent({
    eventBusName: process.env.EVENT_BUS_NAME ?? "default", source: "spawnpoint.access", detailType: "Game Invitation", detail,
  });
  if (refused !== null) {
    await accessTable.update({ TableName: tableName, Key: playerInvitationKey(invitationId),
      UpdateExpression: "SET #status = :failed", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":failed": "PUBLISH_FAILED" },
    });
    return errorResponse(502, "invitation_publish_failed");
  }
  return response(202, { invitation: { id: invitationId, audience, recipientCount: audience === "direct" ? recipientIdentityIds.length : null, state: "queued" } });
}

export async function invitationHistory(identity: Identity, gameId: string, worldId: string): Promise<Response> {
  const page = await accessTable.query({
    TableName: tableName, IndexName: accessIndexName, KeyConditionExpression: "gsi1pk = :sender",
    ExpressionAttributeValues: { ":sender": playerInvitationSenderIndex(identity.id, gameId, worldId) }, ScanIndexForward: false, Limit: 5,
  });
  return response(200, { invitations: (page.Items ?? [])
    .map((item): InvitationSummary => ({
      id: item.invitation_id, audience: item.audience, status: item.status,
      recipientCount: Array.isArray(item.recipient_identity_ids) ? item.recipient_identity_ids.length : null,
      targetCount: item.delivery_target_count ?? null, successCount: item.delivery_success_count ?? null,
      failureCount: item.delivery_failure_count ?? null, createdAt: item.created_at,
    })) });
}
