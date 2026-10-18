import { permissionRoute, type Route } from "./routing.ts";
import { controlPlane, createControlPlaneSubscription } from "./control-plane.ts";

export const controlPlaneRoutes: Readonly<Record<string, Route>> = {
  "GET /control-plane": permissionRoute("status.read", (identity) => controlPlane(identity)),
  "POST /control-plane/subscriptions": permissionRoute("status.read", (identity) => createControlPlaneSubscription(identity))
};
