/*
 * A session record changed state. The panel learns of it through the same
 * invalidation channel as a projection update, so a ready or moving session
 * shows without waiting for its workflow to end.
 */

export type SessionChangePublisher = Readonly<{
  publish: (event: Readonly<{ source: string; detailType: string; detail: unknown }>) => Promise<string | null>;
}>;

/** Tells the panels a record changed; never fails, since the record is already written. */
export type SessionChangeNotifier = (serverId: string) => Promise<void>;

type Log = Pick<Console, "warn">;

export function sessionChangeNotifier(bus: SessionChangePublisher, log: Log, now: () => number = Date.now): SessionChangeNotifier {
  return async (serverId) => {
    try {
      const refused = await bus.publish({
        source: "spawnpoint.control-plane",
        detailType: "Session Changed",
        detail: { schemaVersion: 1, serverId, observedAtEpochMilliseconds: now() },
      });
      if (refused !== null) log.warn("session_changed_refused", serverId, refused);
    } catch (error) {
      log.warn("session_changed_failed", serverId, error instanceof Error ? error.name : "UnknownError");
    }
  };
}
