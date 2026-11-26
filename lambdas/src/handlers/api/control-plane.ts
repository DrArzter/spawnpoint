import { type Identity, can } from "../../access/domain.ts";
import { readControlPlaneSnapshot } from "../../control-plane/read-model.ts";
import { dashboardControlPlaneSources } from "../../control-plane/aws.ts";
import { issueSubscriptionTicket, subscriptionTicketItem, subscriptionTicketLifetimeSeconds } from "../../control-plane/subscriptions.ts";
import { type Response, response } from "./http.ts";
import { accessTable } from "./access-store.ts";
import type { ControlPlaneSnapshot, Deployment } from "../../../../contract/control-plane.ts";

const controlPlaneViewTable = process.env.CONTROL_PLANE_VIEW_TABLE;
if (!controlPlaneViewTable) throw new Error("missing environment variable: CONTROL_PLANE_VIEW_TABLE");

const controlPlaneWebSocketUrl = process.env.CONTROL_PLANE_WEBSOCKET_URL;
if (!controlPlaneWebSocketUrl) throw new Error("missing environment variable: CONTROL_PLANE_WEBSOCKET_URL");

export async function controlPlane(identity: Identity): Promise<Response> {
  const snapshot = await readControlPlaneSnapshot(dashboardControlPlaneSources(), {
    includeInfrastructure: can(identity, "access.manage"),
    includeDesiredRelease: can(identity, "release.read"),
    // The host part of every address; the game's port completes it. Withheld
    // from a caller who may not read the connection, like any other reference.
    connectionHost: can(identity, "connection.read") ? process.env.CONNECTION_HOST ?? null : null,
    dnsSuffix: can(identity, "connection.read") ? process.env.GAME_DNS_SUFFIX ?? null : null,
    spotEnabled: process.env.SPAWNPOINT_SPOT === "enabled",
  });
  const body: ControlPlaneSnapshot = { ...snapshot, deployment: deployment() };
  return response(200, body);
}

function deployment(): Deployment {
  const placement = process.env.SPAWNPOINT_PLACEMENT;
  return {
    placement: placement === "shared" || placement === "fleet" ? placement : "single",
    launchEnabled: process.env.SPAWNPOINT_LAUNCH === "enabled",
    dnsAvailable: Boolean(process.env.GAME_DNS_SUFFIX),
  };
}

export async function createControlPlaneSubscription(identity: Identity): Promise<Response> {
  const ticket = issueSubscriptionTicket();
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  await accessTable.put({
    TableName: controlPlaneViewTable,
    Item: subscriptionTicketItem(ticket, identity.id, nowEpochSeconds),
    ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });
  return response(201, {
    url: controlPlaneWebSocketUrl,
    ticket,
    expiresInSeconds: subscriptionTicketLifetimeSeconds,
  });
}
