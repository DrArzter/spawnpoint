import { type EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

/** One event for the bus. */
export type BusEvent = Readonly<{ source: string; detailType: string; detail: unknown; eventBusName?: string }>;

/** Publishes events; `publish` answers why one was refused, or null when it was taken. */
export type EventBus = Readonly<{ publish: (event: BusEvent) => Promise<string | null> }>;

export function eventBus(client: Pick<EventBridgeClient, "send">): EventBus {
  return {
    async publish(event) {
      const published = await client.send(new PutEventsCommand({ Entries: [{
        ...(event.eventBusName === undefined ? {} : { EventBusName: event.eventBusName }),
        Source: event.source, DetailType: event.detailType, Detail: JSON.stringify(event.detail),
      }] }));
      return (published.FailedEntryCount ?? 0) > 0 ? published.Entries?.[0]?.ErrorMessage ?? "EventBridge refused the event" : null;
    },
  };
}
