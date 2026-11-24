import { eventBus, type BusEvent } from "../../control-plane/aws-event-bus.ts";
import { events } from "./aws-clients.ts";

export type { BusEvent };

const bus = eventBus(events);

/** Publishes one event; answers why it was refused, or null when it was taken. */
export function publishEvent(event: BusEvent): Promise<string | null> {
  return bus.publish(event);
}
