/*
 * The console gateway (ADR-0063): what an operator may type, and what the
 * host's answer means. Pure, so the rules are tested without AWS.
 */

export const MAX_CONSOLE_COMMAND_LENGTH = 256;
/** What one recorded reply keeps; a game can answer with pages. */
export const CONSOLE_OUTPUT_LIMIT = 4000;
/** How long the record of a command is kept: long enough to answer "who ran that". */
export const CONSOLE_RECORD_DAYS = 90;

// A command that ends the game outside its lifecycle skips the verified backup
// and leaves the record saying the session still runs. Stop is a verb of the
// world page; the console refuses it. Factorio's commands start with a slash.
const LIFECYCLE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  minecraft: ["stop", "save-off"],
  factorio: ["quit"],
  zomboid: ["quit"],
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

/**
 * What an SSM invocation of the console document says, in the console's
 * words. The entry script's exit codes: 3 the game did not answer, 4 it has no
 * console; the document's own 9, this host has no console script yet.
 */
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
      if (invocation.responseCode === 9 || invocation.responseCode === 4) {
        return { status: "unavailable", output: clip(invocation.output || invocation.error) };
      }
      return { status: "failed", output: clip(invocation.output || invocation.error) };
  }
}

export type ConsoleEntry = Readonly<{
  id: string;
  at: string;
  identityId: string;
  displayName: string;
  worldId: string;
  command: string;
  status: ConsoleStatus;
  output: string | null;
}>;
