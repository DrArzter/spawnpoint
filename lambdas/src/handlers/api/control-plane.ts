import { type Identity, isBuiltInRoleId, builtInRoles, type Permission, hasPermission } from "../../access/domain.ts";
import { readControlPlaneSnapshot } from "../../control-plane/read-model.ts";
import { dashboardControlPlaneSources } from "../../control-plane/aws.ts";
import { issueSubscriptionTicket, subscriptionTicketItem, subscriptionTicketLifetimeSeconds } from "../../control-plane/subscriptions.ts";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { type Response, response } from "./http.ts";
import { document } from "./access-store.ts";

const controlPlaneViewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!controlPlaneViewTable) throw new Error("missing environment variable: CONTROL_PLANE_VIEW_TABLE");

const controlPlaneWebSocketUrl = process.env.CONTROL_PLANE_WEBSOCKET_URL;
if (!controlPlaneWebSocketUrl) throw new Error("missing environment variable: CONTROL_PLANE_WEBSOCKET_URL");

export async function controlPlane(identity: Identity): Promise<Response> {
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

export async function createControlPlaneSubscription(identity: Identity): Promise<Response> {
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
