/*
 * The console gateway (ADR-0063): what an operator may type, and what the
 * host's answer means. Pure, so the rules are tested without AWS.
 */

import hostOutput from "../../../server/scripts/host-output.json" with { type: "json" };

export const MAX_CONSOLE_COMMAND_LENGTH = 256;
/** What one recorded reply keeps; a game can answer with pages. */
export const CONSOLE_OUTPUT_LIMIT = 4000;
/** How long the record of a command is kept: long enough to answer "who ran that". */
export const CONSOLE_RECORD_DAYS = 90;

// A command that ends the game outside its lifecycle skips the verified backup
// and leaves the record saying the session still runs. Stop is a verb of the
// world page; the console refuses it. Factorio's commands start with a slash.
// Valheim takes no command from outside the game, so its host answers every
// one with "has no console"; nothing reaches the server to refuse.
// Palworld's console speaks its REST API, whose shutdown and stop end the game.
const LIFECYCLE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  minecraft: ["stop", "save-off"],
  factorio: ["quit"],
  zomboid: ["quit"],
  valheim: [],
  palworld: ["shutdown", "stop"],
};

export type ConsoleCommandCheck =
  | Readonly<{ ok: true; command: string }>
  | Readonly<{ ok: false; reason: "invalid_command" | "lifecycle_command" }>;

export function checkConsoleCommand(gameId: string, raw: unknown): ConsoleCommandCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_command" };
  const command = raw.trim();
  // One line of text, as the host also insists on.
  if (command.length === 0 || command.length > MAX_CONSOLE_COMMAND_LENGTH || /[\u0000-\u001f\u007f]/.test(command)) {
    return { ok: false, reason: "invalid_command" };
  }
  const verb = (command.replace(/^\/+/, "").split(/\s+/)[0] ?? "").toLowerCase();
  if ((LIFECYCLE_COMMANDS[gameId] ?? []).includes(verb)) return { ok: false, reason: "lifecycle_command" };
  return { ok: true, command };
}

export function encodeConsoleCommand(command: string): string {
  return Buffer.from(command, "utf8").toString("base64");
}

export type ConsoleStatus = "pending" | "succeeded" | "failed" | "unavailable" | "timed_out";

export type ConsoleInvocation = Readonly<{
  status: string;
  responseCode: number | null;
  output: string;
  error: string;
}>;

function clip(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > CONSOLE_OUTPUT_LIMIT ? `${trimmed.slice(0, CONSOLE_OUTPUT_LIMIT)}\n…` : trimmed;
}

// The exit codes that mean the console cannot be used here, as the host and
// the console document define them (server/scripts/host-output.json).
const UNAVAILABLE: ReadonlySet<number> = new Set(hostOutput.console.unavailable);

/** What an SSM invocation of the console document says, in the console's words. */
export function consoleResult(invocation: ConsoleInvocation): Readonly<{ status: ConsoleStatus; output: string | null }> {
  switch (invocation.status) {
    case "Pending":
    case "InProgress":
    case "Delayed":
      return { status: "pending", output: null };
    case "Success":
      return { status: "succeeded", output: clip(invocation.output) };
    case "TimedOut":
    case "Cancelled":
      return { status: "timed_out", output: null };
    default:
      if (invocation.responseCode !== null && UNAVAILABLE.has(invocation.responseCode)) {
        return { status: "unavailable", output: clip(invocation.output || invocation.error) };
      }
      return { status: "failed", output: clip(invocation.output || invocation.error) };
  }
}

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

/** A console record from the access table, as the API answers it. */
export function consoleEntryFromItem(item: Readonly<Record<string, unknown>>): ConsoleEntry {
  const text = (key: string) => (typeof item[key] === "string" ? item[key] as string : "");
  return {
    id: text("command_id"),
    at: text("created_at"),
    identityId: text("identity_id"),
    displayName: typeof item.display_name === "string" ? item.display_name : null,
    agent: typeof item.agent_name === "string" ? item.agent_name : null,
    worldId: text("world_id"),
    command: text("command"),
    status: (text("status") || "pending") as ConsoleStatus,
    output: typeof item.output === "string" ? item.output : null,
  };
}
