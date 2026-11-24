/*
 * A world's recent log (ADR-0094): what the host's answer means, and the
 * redaction that keeps addresses, ids and player names out of it. Pure, so the
 * rules are tested without AWS.
 */

import type { WorldLogRead, WorldLogStatus } from "../../../contract/world-log.ts";
import hostOutput from "../../../server/scripts/host-output.json" with { type: "json" };
import type { ConsoleInvocation } from "./console.ts";

export type { WorldLogRead, WorldLogStatus };

/** How long a log read is kept: the answer is read within minutes. */
export const WORLD_LOG_RECORD_HOURS = 24;

const UNAVAILABLE: ReadonlySet<number> = new Set(hostOutput.worldLog.unavailable);

/** A log read as the access table keeps it: never the log itself. */
export type WorldLogRecord = Readonly<{
  id: string;
  at: string;
  gameId: string;
  worldId: string;
  hostId: string;
  identityId: string;
}>;

export type WorldLogRecords = Readonly<{
  append: (record: WorldLogRecord) => Promise<void>;
  /** The read, when it was made for this game's world; null otherwise. */
  find: (gameId: string, worldId: string, readId: string) => Promise<WorldLogRecord | null>;
}>;

// The phrasing most game servers use when a player arrives or leaves. A game
// whose log names players another way is still covered by its whitelist.
const PLAYER_PATTERNS: readonly RegExp[] = [
  /UUID of player (\S{2,32}) is/g,
  /(\S{2,32})\[\/[^\]]*\] logged in/g,
  /(\S{2,32}) (?:joined|left) the (?:game|server)/g,
  /(\S{2,32}) lost connection/g,
  /<(\S{2,32})> /g,
];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
// Hex groups joined by colons. A clock time has at most three groups, so an
// IPv6 address is told apart by a double colon or at least four colons.
const IPV6_CANDIDATE = /[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}/g;
const CHAT = /<(player-\d+)> .*$/;

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isIpv6(candidate: string): boolean {
  const colons = candidate.split(":").length - 1;
  return candidate.includes("::") ? colons >= 2 && /[0-9A-Fa-f]/.test(candidate) : colons >= 4;
}

/** The player names a log mentions, in the order it first mentions them. */
export function playerNamesIn(text: string): readonly string[] {
  const found: { at: number; name: string }[] = [];
  for (const pattern of PLAYER_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, name: match[1]! });
  }
  return [...new Set(found.sort((left, right) => left.at - right.at).map(({ name }) => name))];
}

/**
 * The log with each address, id, email and player name replaced by a token.
 * A player keeps one token through the log, so "player-1 joined" and
 * "player-1 lost connection" still read as one person. Chat text is removed.
 */
export function redactLog(text: string, knownNames: readonly string[]): readonly string[] {
  const names = [...new Set([...playerNamesIn(text), ...knownNames])].filter((name) => name.length >= 2);
  // Longer names first, so a name inside another is not replaced first.
  const tokens = new Map(names.map((name, index) => [name, `player-${index + 1}`]));
  const byLength = [...names].sort((left, right) => right.length - left.length);
  let redacted = text.replaceAll(EMAIL, "<email>").replaceAll(UUID, "<uuid>").replaceAll(IPV4, "<ip>");
  redacted = redacted.replaceAll(IPV6_CANDIDATE, (candidate) => (isIpv6(candidate) ? "<ip>" : candidate));
  for (const name of byLength) {
    redacted = redacted.replaceAll(new RegExp(String.raw`(?<![\w-])${escapeRegExp(name)}(?![\w-])`, "g"), tokens.get(name)!);
  }
  return redacted
    .split("\n")
    .map((line) => line.replace(CHAT, "<$1> [chat removed]"))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

/** What an SSM invocation of the log document says, before redaction. */
export function worldLogResult(invocation: ConsoleInvocation): Readonly<{ status: WorldLogStatus; text: string | null }> {
  switch (invocation.status) {
    case "Pending":
    case "InProgress":
    case "Delayed":
      return { status: "pending", text: null };
    case "Success":
      return { status: "succeeded", text: invocation.output };
    case "TimedOut":
    case "Cancelled":
      return { status: "timed_out", text: null };
    default:
      return invocation.responseCode !== null && UNAVAILABLE.has(invocation.responseCode)
        ? { status: "unavailable", text: null }
        : { status: "failed", text: null };
  }
}
