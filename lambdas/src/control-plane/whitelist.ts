/*
 * A world's whitelist (ADR-0066): the player names its record keeps, in the
 * case the player types them. What a name may be, and how a running server
 * lists its own, are the game's rules (its manifest's whitelist, ADR-0090).
 */

export const WHITELIST_LIMIT = 200;

/** A game's whitelist rules, as its manifest states them. */
export type WhitelistRules = Readonly<{
  namePattern: RegExp;
  nameHint: string;
  /** The console command that lists a running server's own whitelist; null when it cannot list. */
  listCommand: string | null;
  /** The list reply: group 1 the count, group 2 the names, comma separated. */
  listReply: RegExp | null;
  /** The reply that says the list is empty. */
  listEmpty: RegExp | null;
}>;

export function playerNameValid(name: unknown, rules: WhitelistRules): name is string {
  return typeof name === "string" && rules.namePattern.test(name);
}

export type WhitelistCheck =
  | Readonly<{ ok: true; names: readonly string[] }>
  | Readonly<{ ok: false; error: "invalid_whitelist" | "invalid_player_name" | "duplicate_player_name" | "whitelist_too_long"; name?: string }>;

/**
 * The names, each a name the game accepts and none twice. Two names that
 * differ only in case are almost always one typing mistake, so they are
 * refused. Kept in the order given.
 */
export function checkWhitelist(raw: unknown, rules: WhitelistRules): WhitelistCheck {
  if (!Array.isArray(raw)) return { ok: false, error: "invalid_whitelist" };
  if (raw.length > WHITELIST_LIMIT) return { ok: false, error: "whitelist_too_long" };
  const seen = new Set<string>();
  for (const name of raw) {
    if (!playerNameValid(name, rules)) return { ok: false, error: "invalid_player_name", name: typeof name === "string" ? name.slice(0, 32) : String(name) };
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: "duplicate_player_name", name };
    seen.add(key);
  }
  return { ok: true, names: raw as string[] };
}

/** The names a running server's own whitelist holds, from its list reply; null when the reply is not one. */
export function parseServerWhitelist(output: string, rules: WhitelistRules): readonly string[] | null {
  if (rules.listReply === null) return null;
  const text = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/§./g, "");
  if (rules.listEmpty?.test(text) === true) return [];
  const match = rules.listReply.exec(text);
  if (match === null) return null;
  const names = (match[2] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length !== Number(match[1])) return null;
  const check = checkWhitelist(names, rules);
  return check.ok ? check.names : null;
}
