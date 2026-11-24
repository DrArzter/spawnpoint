// One console command (ADR-0063), as the API answers it.

export type ConsoleStatus = "pending" | "succeeded" | "failed" | "unavailable" | "timed_out";

export type ConsoleEntry = Readonly<{
  id: string;
  at: string;
  identityId: string;
  /** Null once the person who ran the command is deleted (ADR-0071). */
  displayName: string | null;
  /** The MCP client that sent the command for the person, by its registered name; null from the panel. */
  agent: string | null;
  worldId: string;
  command: string;
  status: ConsoleStatus;
  output: string | null;
}>;
