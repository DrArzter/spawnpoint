import type { Game } from "../model";
import { t } from "../i18n";

/**
 * ADR-0109: a game no session has run in this deployment is the Owner's to
 * try. Only the Owner role holds this permission, so it says who sees one.
 */
const OWNER_ONLY = "access.owner.grant";

/** The games a person is offered: every game for an Owner, the proven ones for anyone else. */
export function offeredGames(games: readonly Game[], granted: ReadonlySet<string>): readonly Game[] {
  return granted.has(OWNER_ONLY) ? games : games.filter((game) => game.proven);
}

/** The short note an unproven game carries; null for a game that has run here. */
export function gameProofNote(game: Game): string | null {
  return game.proven ? null : t("world.gameNotRunHere");
}
