// A world's recent log (ADR-0094), as the API answers it. The lines carry no
// network address, player id or player name: the API puts tokens in their place.

export type WorldLogStatus = "pending" | "succeeded" | "failed" | "unavailable" | "timed_out";

export type WorldLogRead = Readonly<{
  id: string;
  at: string;
  status: WorldLogStatus;
  /** The game's newest lines, oldest first; null until the host answers. */
  lines: readonly string[] | null;
}>;
