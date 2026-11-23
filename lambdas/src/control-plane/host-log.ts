// The host's own lines of a start, filtered for the panel. The host's output
// can quote secrets (a Compose warning once quoted pieces of an API key), so
// this is an allow-list: a line passes only when it has a known safe shape, and
// what passes is redacted again. Nothing here reads or writes AWS.

export type HostLogKind = "step" | "result" | "container" | "error" | "warning" | "game";

export type HostLogLine = Readonly<{ at: string; kind: HostLogKind; text: string }>;

/** One raw event of a command's output stream. */
export type RawLogEvent = Readonly<{ timestamp: number; message: string }>;

/** The most lines returned, newest last. */
export const MAX_HOST_LOG_LINES = 40;
const MAX_TEXT = 200;

const STEP_LABELS: Readonly<Record<string, string>> = {
  session_start: "Session started",
  world_catalog: "World catalogue read",
  world_prepared: "World prepared",
  connectivity_prepared: "Network prepared",
  release_pointer_read: "Release pointer read",
  release_downloaded: "Release downloaded",
  release_reconciled: "Release reconciled",
  game_starting: "Game starting",
  game_ready: "Game ready",
  address_published: "Address published",
};

// Keys whose value is safe to show; a value is short and plain.
const RESULT_LABELS: Readonly<Record<string, string>> = {
  release: "Release",
  downloaded: "Downloaded",
  kept: "Kept",
  reused: "Reused",
  seconds: "Seconds",
  mods: "Mods",
  files: "Files",
  roots: "Roots",
  world_data: "World data",
  observability: "Observability",
  result: "Result",
};

const STEP = /^step=([a-z][a-z0-9_]{0,39}) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) elapsed_seconds=(\d{1,7})$/;
const RESULT = /^([a-z_]{1,20})=([A-Za-z0-9._:+/-]{1,60})$/;
// Compose prefixes a tick and suffixes a duration; both words are dropped before the match.
const CONTAINER = /^Container ([\w.-]{1,101}) (Creating|Created|Starting|Started|Stopping|Stopped)$/;
const DURATION = /^\d{1,6}(?:\.\d{1,6})?s$/;

function containerWords(line: string): string {
  const words = line.split(/\s+/).filter((word) => word !== "");
  if (words[0] === "✔") words.shift();
  if (words.length > 0 && DURATION.test(words.at(-1)!)) words.pop();
  return words.join(" ");
}
const NOTICE = /^(error|warning):\s*(.{1,400})$/i;
const GAME = /^mc-1\s+\|\s?(.*)$/;
const GAME_FAULT = /\b(?:ERROR|WARN|WARNING|FATAL)\b|Exception|OutOfMemoryError/;
// Compose names the variable it could not find and may quote part of its value.
const UNSET = /variable[^\n]*not set|defaulting to a blank/i;

// eslint-disable-next-line no-control-regex -- terminal escapes and control characters are removed
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f]/g;

// A name, an optional closing quote and a separator. The value after a secret
// name is hidden; other values are scanned again for names of their own.
const ASSIGNMENT = /(["']?[\w.-]{1,100})(["']?\s*[:=]\s*)/g;
const VALUE = /"[^"]*"|'[^']*'|\S+/y;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;

function hideSecretValues(text: string): string {
  let out = "";
  let from = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const at = match.index + match[0].length;
    if (match.index < from || !SECRET_NAME.test(match[1]!)) continue;
    VALUE.lastIndex = at;
    const value = VALUE.exec(text);
    if (value === null) continue;
    out += `${text.slice(from, at)}[redacted]`;
    from = at + value[0].length;
  }
  return out + text.slice(from);
}

/** Hides anything shaped like a secret, an address or an identifier. */
export function redact(text: string): string {
  return hideSecretValues(text.replace(/\$2[abxy]?\$\S*/g, "[redacted]"))
    .replace(/[A-Za-z0-9+/_=]{32,}/g, "[redacted]")
    .replace(/\b[0-9a-fA-F]{20,}\b/g, "[redacted]")
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "[id]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[ip]");
}

function shown(text: string): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

function stepText(key: string, seconds: string): string {
  const label = STEP_LABELS[key] ?? key.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
  return `${label} (${seconds} s)`;
}

type Shape = Readonly<{ kind: HostLogKind; text: string; at?: string }>;

// The safe shape of one line, or null. The caller redacts what this returns.
function shape(line: string): Shape | null {
  const step = STEP.exec(line);
  if (step) return { kind: "step", text: stepText(step[1]!, step[3]!), at: step[2]! };
  const result = RESULT.exec(line);
  if (result && RESULT_LABELS[result[1]!] !== undefined) return { kind: "result", text: `${RESULT_LABELS[result[1]!]}: ${result[2]}` };
  const container = CONTAINER.exec(containerWords(line));
  if (container) return { kind: "container", text: `Container ${container[1]} ${container[2]}` };
  const notice = NOTICE.exec(line);
  if (notice) return { kind: notice[1]!.toLowerCase() === "error" ? "error" : "warning", text: notice[2]! };
  const game = GAME.exec(line);
  if (game?.[1] !== undefined && GAME_FAULT.test(game[1])) return { kind: "game", text: game[1] };
  return null;
}

/**
 * The lines worth showing, oldest first, at most `MAX_HOST_LOG_LINES` and
 * the newest of them. Events are in any order.
 */
export function filterHostLog(events: readonly RawLogEvent[]): HostLogLine[] {
  const kept: HostLogLine[] = [];
  const ordered = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.timestamp - b.event.timestamp || a.index - b.index);
  for (const { event } of ordered) {
    for (const raw of event.message.replace(ESCAPES, "").split(/[\r\n]+/)) {
      const line = raw.replace(CONTROLS, " ").trim();
      if (line === "" || UNSET.test(line)) continue;
      const found = shape(line);
      if (found === null) continue;
      const text = shown(found.text);
      if (text === "") continue;
      kept.push({ at: found.at ?? new Date(event.timestamp).toISOString(), kind: found.kind, text });
    }
  }
  return kept.slice(-MAX_HOST_LOG_LINES);
}
