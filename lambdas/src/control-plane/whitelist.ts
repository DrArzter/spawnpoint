/*
 * A world's whitelist (ADR-0066): the Minecraft names its record keeps. The
 * host writes them with the UUIDs an offline server derives from the name, so
 * the name must be the one the player types, in the case they type it.
 */

export const WHITELIST_LIMIT = 200;
const MINECRAFT_NAME = /^\w{3,16}$/;

export function minecraftNameValid(name: unknown): name is string {
  return typeof name === "string" && MINECRAFT_NAME.test(name);
}

export type WhitelistCheck =
  | Readonly<{ ok: true; names: readonly string[] }>
  | Readonly<{ ok: false; error: "invalid_whitelist" | "invalid_player_name" | "duplicate_player_name" | "whitelist_too_long"; name?: string }>;

/**
 * The names, each a Minecraft name and none twice. Two names that differ only
 * in case are two different players to an offline server, and almost always
 * one typing mistake, so they are refused. Kept in the order given.
 */
export function checkWhitelist(raw: unknown): WhitelistCheck {
  if (!Array.isArray(raw)) return { ok: false, error: "invalid_whitelist" };
  if (raw.length > WHITELIST_LIMIT) return { ok: false, error: "whitelist_too_long" };
  const seen = new Set<string>();
  for (const name of raw) {
    if (!minecraftNameValid(name)) return { ok: false, error: "invalid_player_name", name: typeof name === "string" ? name.slice(0, 32) : String(name) };
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: "duplicate_player_name", name };
    seen.add(key);
  }
  return { ok: true, names: raw as string[] };
}

/**
 * The command that lists a running server's own whitelist, per game (ADR-0066
 * amendment). A game that keeps a whitelist but cannot list it has no entry.
 */
export const SERVER_WHITELIST_COMMANDS: Readonly<Record<string, string>> = { minecraft: "whitelist list" };

// "There are 2 whitelisted players: a, b" (older servers: "player(s)").
const SERVER_LIST_REPLY = /There are (\d+) whitelisted player(?:s|\(s\))?:\s*(.*)/;

/**
 * The names in a Minecraft `whitelist list` reply, or null when the reply is
 * not one this can trust. A wrong count or a name the panel would refuse to
 * save is null: reading a partial list and saving it would drop players.
 */
export function parseServerWhitelist(output: string): readonly string[] | null {
  const text = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/§./g, "");
  if (/There are no whitelisted players/.test(text)) return [];
  const match = SERVER_LIST_REPLY.exec(text);
  if (match === null) return null;
  const names = (match[2] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length !== Number(match[1])) return null;
  const check = checkWhitelist(names);
  return check.ok ? check.names : null;
}
