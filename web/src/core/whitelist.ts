/*
 * A world's whitelist (ADR-0066), as the panel checks a name before it sends
 * it. An offline server derives a player's UUID from the exact name, so the
 * case typed is the case kept. The API and the host check every name again.
 */

const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/;

export function minecraftNameValid(name: string): boolean {
  return MINECRAFT_NAME.test(name);
}

/** Why a name cannot be added to these, or null when it can. */
export function whitelistNameError(name: string, names: readonly string[]): string | null {
  if (!minecraftNameValid(name)) return "3 to 16 letters, digits or underscores, as the player types it.";
  if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) return "Already on the list.";
  return null;
}
