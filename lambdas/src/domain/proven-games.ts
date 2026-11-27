/*
 * A game is proven once a session of it became ready in this deployment
 * (ADR-0109). The fact is one item per game in the lifecycle table, kept for
 * good: the session history and the workflow runs it could be derived from
 * are pruned.
 */

const PROVEN_KEY_PREFIX = "proven#";

/** The lifecycle table key of a game's proof. Every reader and writer builds it here. */
export function provenGameKey(gameId: string): string {
  return `${PROVEN_KEY_PREFIX}${gameId}`;
}

/** The first ready session of a game, as stored (snake_case attributes). */
export type GameProof = Readonly<{ gameId: string; worldId: string; firstReadyAt: string }>;
