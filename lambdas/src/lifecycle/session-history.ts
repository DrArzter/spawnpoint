import { closeSessionHost, openSessionHost, type SessionHost } from "../domain/session-history.ts";

export type VersionedSessionHistory = Readonly<{ revision: number; entries: readonly SessionHost[] }>;

export interface SessionHistoryStore {
  read(worldId: string): Promise<VersionedSessionHistory | null>;
  create(worldId: string, entries: readonly SessionHost[]): Promise<boolean>;
  compareAndSet(worldId: string, expectedRevision: number, entries: readonly SessionHost[]): Promise<boolean>;
}

export type SessionHistoryInput =
  | Readonly<{ action: "openSessionHistory"; worldId: string; sessionId: string; hostId: string }>
  | Readonly<{ action: "closeSessionHistory"; worldId: string; sessionId: string }>;

const HISTORY_ACTIONS: ReadonlySet<string> = new Set(["openSessionHistory", "closeSessionHistory"]);

export function isSessionHistoryInput(input: Readonly<{ action: string }>): input is SessionHistoryInput {
  return HISTORY_ACTIONS.has(input.action);
}

const MAX_ATTEMPTS = 5;

function requireId(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

/**
 * Keeps one bounded item per world. The lifecycle lease already allows one
 * session of a world at a time, so a conflict is a retry of the same step.
 */
export function createSessionHistoryCoordinator(
  store: SessionHistoryStore,
  now: () => Date = () => new Date(),
): (input: SessionHistoryInput) => Promise<Readonly<{ entries: number }>> {
  return async (input) => {
    const worldId = requireId("worldId", input.worldId);
    const sessionId = requireId("sessionId", input.sessionId);
    const hostId = input.action === "openSessionHistory" ? requireId("hostId", input.hostId) : "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await store.read(worldId);
      if (current === null && input.action === "closeSessionHistory") return { entries: 0 };
      const next = input.action === "openSessionHistory"
        ? openSessionHost(current?.entries ?? [], { sessionId, hostId }, now())
        : closeSessionHost(current?.entries ?? [], sessionId, now());
      const stored = current === null
        ? await store.create(worldId, next)
        : await store.compareAndSet(worldId, current.revision, next);
      if (stored) return { entries: next.length };
    }
    throw new Error("session history changed repeatedly during conditional write");
  };
}
