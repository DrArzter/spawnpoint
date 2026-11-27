import { can, type Identity } from "../../access/domain.ts";
import type { ControlPlaneSources } from "../../control-plane/read-model.ts";
import { errorResponse, type Response } from "./http.ts";

/**
 * ADR-0109: a game no session has run in this deployment is the Owner's to
 * try. Creating or starting one of its worlds needs the permission only the
 * Owner role holds; any other role is refused, whatever its own grants.
 */
export async function refuseUnprovenGame(identity: Identity, gameId: string, sources: Pick<ControlPlaneSources, "listProvenGames">): Promise<Response | null> {
  if (can(identity, "access.owner.grant") || !sources.listProvenGames) return null;
  const proven = await sources.listProvenGames();
  return proven.has(gameId) ? null : errorResponse(403, "game_not_proven");
}
