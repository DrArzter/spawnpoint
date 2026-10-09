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
