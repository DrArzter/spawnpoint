import type { GameProof } from "../domain/proven-games.ts";
import { closeSessionHost, openSessionHost, type SessionHost } from "../domain/session-history.ts";

export type VersionedSessionHistory = Readonly<{ revision: number; entries: readonly SessionHost[] }>;

export interface SessionHistoryStore {
  read(worldId: string): Promise<VersionedSessionHistory | null>;
  create(worldId: string, entries: readonly SessionHost[]): Promise<boolean>;
  compareAndSet(worldId: string, expectedRevision: number, entries: readonly SessionHost[]): Promise<boolean>;
}

/** Keeps the first ready session of each game; a second record of the same game changes nothing (ADR-0109). */
export interface GameProofStore {
  record(proof: GameProof): Promise<void>;
}

export type SessionHistoryInput =
  /** `gameId` is absent from a workflow deployed before ADR-0109. */
  | Readonly<{ action: "openSessionHistory"; worldId: string; sessionId: string; hostId: string; gameId?: string }>
  | Readonly<{ action: "closeSessionHistory"; worldId: string; sessionId: string }>;

const HISTORY_ACTIONS: ReadonlySet<string> = new Set(["openSessionHistory", "closeSessionHistory"]);

export function isSessionHistoryInput(input: Readonly<{ action: string }>): input is SessionHistoryInput {
  return HISTORY_ACTIONS.has(input.action);
}

const MAX_ATTEMPTS = 5;
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
  proofs?: GameProofStore,
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
      if (!stored) continue;
      // A session opens its history when it is ready: that proves its game here.
      // The proof is a convenience of the panel; it never fails a start.
      if (input.action === "openSessionHistory" && proofs && GAME_ID.test(input.gameId ?? "")) {
        try {
          await proofs.record({ gameId: input.gameId as string, worldId, firstReadyAt: now().toISOString() });
        } catch (error) {
          console.warn("could not record the game's proof", input.gameId, error);
        }
      }
      return { entries: next.length };
    }
    throw new Error("session history changed repeatedly during conditional write");
  };
}
