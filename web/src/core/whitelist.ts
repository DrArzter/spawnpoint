/*
 * A world's whitelist (ADR-0066), as the panel checks a name before it sends
 * it. The game's module states what a player's name may be (ADR-0090); the
 * case typed is the case kept. The API and the host check every name again.
 */

/** The rule a whitelisted name must meet, as the snapshot carries it. */
export type PlayerNameRule = Readonly<{ pattern: string; hint: string }>;

/** Why a name cannot be added to these, or null when it can. */
export function whitelistNameError(name: string, names: readonly string[], rule: PlayerNameRule | null): string | null {
  if (rule !== null && !new RegExp(rule.pattern).test(name)) return `${rule.hint.charAt(0).toUpperCase()}${rule.hint.slice(1)}.`;
  if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) return "Already on the list.";
  return null;
}
