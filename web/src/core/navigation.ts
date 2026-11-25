import type { Page } from "../model";
import { t } from "../i18n";

// A page is offered only when the role permits it and this deployment serves
// the route that makes it useful. The demo transport can advertise prototype
// capabilities without making an unfinished page visible in production.
const navigation: readonly Readonly<{ id: Page; label: string; permission: string; capability?: string }>[] = [
  { id: "worlds", label: t("common.worlds"), permission: "status.read" },
  { id: "releases", label: t("common.releases"), permission: "release.read" },
  { id: "access", label: t("common.access"), permission: "access.read" },
];

export function visibleNavigation(granted: ReadonlySet<string>, capabilities: ReadonlySet<string>) {
  return navigation.filter((item) => granted.has(item.permission) && (item.capability === undefined || capabilities.has(item.capability)));
}
