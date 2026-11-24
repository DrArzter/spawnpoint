import { PutEventsCommand } from "@aws-sdk/client-eventbridge";

import { events } from "./aws-clients.ts";

/** One event for the bus (the API's notifications go through EventBridge). */
export type BusEvent = Readonly<{ source: string; detailType: string; detail: unknown; eventBusName?: string }>;

/** Publishes one event; answers why it was refused, or null when it was taken. */
export async function publishEvent(event: BusEvent): Promise<string | null> {
  const published = await events.send(new PutEventsCommand({ Entries: [{
    ...(event.eventBusName === undefined ? {} : { EventBusName: event.eventBusName }),
    Source: event.source, DetailType: event.detailType, Detail: JSON.stringify(event.detail),
  }] }));
  return (published.FailedEntryCount ?? 0) > 0 ? published.Entries?.[0]?.ErrorMessage ?? "EventBridge refused the event" : null;
}
