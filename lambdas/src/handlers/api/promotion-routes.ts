import { permissionRoute, type Route } from "./routing.ts";
import { deployedPromotion } from "./promotion-wiring.ts";
import { parameter } from "./http.ts";

export const promotionRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/promote": permissionRoute("release.promote", (identity, event) =>
    deployedPromotion.promoteWorld(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body)),
};
