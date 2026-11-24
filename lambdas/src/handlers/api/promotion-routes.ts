import { permissionRoute, type Route } from "./routing.ts";
import { deployedPromotion } from "./promotion-wiring.ts";
import { parameter } from "./http.ts";

export const promotionRoutes: Readonly<Record<string, Route>> = {
  "POST /games/{gameId}/worlds/{worldId}/promote": permissionRoute("release.promote", (identity, event) =>
    deployedPromotion.promoteWorld(identity, parameter(event, "gameId"), parameter(event, "worldId"), event.body), {
    name: "promote_world", title: "Move world to a release", effect: "write",
    description: "Move a world onto another built release of its preset, keeping its map. A running world is stopped, backed up and started again.",
    input: {
      release: { type: "string", pattern: String.raw`^\d+\.\d+$`, description: "The release to move to" },
      startAfter: { type: "boolean", description: "Start the world afterwards (the default)" },
    },
    required: ["release"],
  }),
};
