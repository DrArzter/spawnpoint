import { createHash, randomBytes } from "node:crypto";

export const subscriptionTicketLifetimeSeconds = 60;
export const subscriptionConnectionLifetimeSeconds = 3 * 60 * 60;

export function issueSubscriptionTicket(): string {
  return randomBytes(32).toString("base64url");
}

export function subscriptionTicketKey(ticket: string): string {
  return `TICKET#${createHash("sha256").update(ticket).digest("base64url")}`;
}

export function subscriptionTicketItem(
  ticket: string,
  identityId: string,
  nowEpochSeconds: number,
): Record<string, unknown> {
  return {
    pk: subscriptionTicketKey(ticket),
    sk: "CONTROL_PLANE",
    schema_version: 1,
    identity_id: identityId,
    expires_at: nowEpochSeconds + subscriptionTicketLifetimeSeconds,
  };
}

export function controlPlaneConnectionItem(
  connectionId: string,
  identityId: string,
  nowEpochSeconds: number,
): Record<string, unknown> {
  return {
    pk: "SUBSCRIPTIONS#CONTROL_PLANE",
    sk: `CONNECTION#${connectionId}`,
    schema_version: 1,
    connection_id: connectionId,
    identity_id: identityId,
    expires_at: nowEpochSeconds + subscriptionConnectionLifetimeSeconds,
  };
}
