import { notATool, permissionRoute, type Route } from "./routing.ts";
import { controlPlane, createControlPlaneSubscription } from "./control-plane.ts";

export const controlPlaneRoutes: Readonly<Record<string, Route>> = {
  "GET /control-plane": permissionRoute("status.read", (identity) => controlPlane(identity), {
    name: "get_control_plane", title: "Get Spawnpoint control plane", effect: "read", mcp: true,
    description: "List games, worlds, sessions, hosts, releases, permissions, and their current state. Call this before a world action.",
  }),
  "POST /control-plane/subscriptions": notATool("a browser's live-update ticket",
    permissionRoute("status.read", (identity) => createControlPlaneSubscription(identity))),
};
