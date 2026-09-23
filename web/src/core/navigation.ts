import type { Page } from "../model";

// A page is offered only when the role permits it and this deployment serves
// the route that makes it useful. The demo transport can advertise prototype
// capabilities without making an unfinished page visible in production.
const navigation: readonly Readonly<{ id: Page; label: string; permission: string; capability?: string }>[] = [
  { id: "worlds", label: "Worlds", permission: "status.read" },
  { id: "metrics", label: "Metrics", permission: "metrics.read", capability: "hostMetrics" },
  { id: "console", label: "Console", permission: "console.use", capability: "consoleGateway" },
  { id: "releases", label: "Releases", permission: "release.read" },
  { id: "access", label: "Access", permission: "access.read" },
];

export function visibleNavigation(granted: ReadonlySet<string>, capabilities: ReadonlySet<string>) {
  return navigation.filter((item) => granted.has(item.permission) && (item.capability === undefined || capabilities.has(item.capability)));
}
