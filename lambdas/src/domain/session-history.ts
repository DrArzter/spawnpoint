/*
 * Which host each session of a world ran on, and when (ADR-0015). A fleet world
 * gets a new instance for each cold start, so its metrics sit under a different
 * InstanceId every session. This record keeps the link. It is bounded: an entry
 * older than the longest metrics range is dropped, so one item per world stays
 * small and the table needs no TTL.
 */

export type SessionHost = Readonly<{
  sessionId: string;
  hostId: string;
  /** When the session became ready, ISO 8601. */
  startedAt: string;
  /** When it stopped; null while it runs, or when the stop was not seen. */
  endedAt: string | null;
}>;

/** The longest metrics range (7 days) and one day of margin. */
export const SESSION_HISTORY_RETENTION_MS = 8 * 24 * 3_600_000;
const MAX_ENTRIES = 200;

/** Drops what ended before the retention window, and keeps the newest entries. */
export function pruneSessionHistory(entries: readonly SessionHost[], now: Date): SessionHost[] {
  const cutoff = now.getTime() - SESSION_HISTORY_RETENTION_MS;
  return entries
    .filter((entry) => entry.endedAt === null || Date.parse(entry.endedAt) >= cutoff)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-MAX_ENTRIES);
}

/**
 * Records that a session is ready on a host. A retry of the same session keeps
 * its first start. A world runs one session at a time, so any other entry still
 * open is a stop that was never recorded: it ends when this one starts.
 */
export function openSessionHost(
  entries: readonly SessionHost[],
  opened: Readonly<{ sessionId: string; hostId: string }>,
  now: Date,
): SessionHost[] {
  const existing = entries.find((entry) => entry.sessionId === opened.sessionId);
  const startedAt = existing?.startedAt ?? now.toISOString();
  const closed = entries
    .filter((entry) => entry.sessionId !== opened.sessionId)
    .map((entry) => entry.endedAt === null ? { ...entry, endedAt: startedAt } : entry);
  return pruneSessionHistory([...closed, { sessionId: opened.sessionId, hostId: opened.hostId, startedAt, endedAt: existing?.endedAt ?? null }], now);
}

/** Records the stop of a session; one already closed, or unknown, is left as it is. */
export function closeSessionHost(entries: readonly SessionHost[], sessionId: string, now: Date): SessionHost[] {
  return pruneSessionHistory(
    entries.map((entry) => entry.sessionId === sessionId && entry.endedAt === null ? { ...entry, endedAt: now.toISOString() } : entry),
    now,
  );
}

/** Whether a stored value has the shape of an entry; a damaged item must not break a metrics read. */
export function isSessionHost(value: unknown): value is SessionHost {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sessionId === "string" && typeof entry.hostId === "string" &&
    typeof entry.startedAt === "string" && !Number.isNaN(Date.parse(entry.startedAt)) &&
    (entry.endedAt === null || (typeof entry.endedAt === "string" && !Number.isNaN(Date.parse(entry.endedAt))));
}
