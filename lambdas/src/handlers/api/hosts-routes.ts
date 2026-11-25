import { permissionRoute, type Route } from "./routing.ts";
import { deployedHosts } from "./hosts-wiring.ts";
import { parameter } from "./http.ts";

export const hostsRoutes: Readonly<Record<string, Route>> = {
  "DELETE /hosts/{instanceId}": permissionRoute("host.manage", (identity, event) =>
    deployedHosts.deleteHost(identity, parameter(event, "instanceId"), event.body), {
    name: "delete_host", title: "Delete a persistent host", effect: "write", destructive: true,
    description: "Delete a stopped persistent host on which no world is placed, with its data volumes. Choose whether the data volumes are kept as snapshots first.",
    input: {
      snapshot: { type: "boolean", description: "Keep a snapshot of each data volume before it is deleted" },
    },
    required: ["snapshot"],
  }),
};
