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

/** The bus events that tell open panels to read the snapshot again. */
export const INVALIDATING_DETAIL_TYPES: readonly string[] = ["Projection Updated", "Session Changed"];

export function invalidatesPanels(event: Readonly<{ source?: string; "detail-type"?: string }>): boolean {
  return event.source === "spawnpoint.control-plane" && INVALIDATING_DETAIL_TYPES.includes(event["detail-type"] ?? "");
}

/**
 * Posts to every connection of one page. One failed post does not keep the
 * message from the others; the failures are raised together at the end, so
 * the invocation still fails and is retried and counted.
 */
export async function postToConnections(
  connectionIds: readonly string[],
  post: (connectionId: string) => Promise<"sent" | "gone">,
  remove: (connectionId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(connectionIds.map(async (connectionId) => {
    if (await post(connectionId) === "gone") await remove(connectionId);
  }));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), `${failures.length} of ${connectionIds.length} connections were not told`);
}
