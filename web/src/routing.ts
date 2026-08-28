import { AccessTab, Page } from "./model";

export type AppRoute = Readonly<{ page: Page; accessTab: AccessTab }>;

const pageByPath: Record<string, Page> = {
  overview: "dashboard",
  metrics: "metrics",
  console: "console",
  releases: "storage",
  access: "access",
  profile: "profile",
};

const pathByPage: Record<Page, string> = {
  dashboard: "overview",
  metrics: "metrics",
  console: "console",
  storage: "releases",
  access: "access",
  profile: "profile",
};

const accessTabs = new Set<AccessTab>(["users", "roles", "notifications"]);

export function readRoute(): AppRoute {
  const [pagePath = "overview", tabPath = "users"] = window.location.hash.replace(/^#\/?/, "").split("/");
  const page = pageByPath[pagePath] ?? "dashboard";
  const accessTab = accessTabs.has(tabPath as AccessTab) ? tabPath as AccessTab : "users";
  return { page, accessTab };
}

export function routeHash(route: AppRoute): string {
  const pagePath = pathByPage[route.page];
  return route.page === "access" ? `#/${pagePath}/${route.accessTab}` : `#/${pagePath}`;
}

export function pushRoute(route: AppRoute): void {
  const nextHash = routeHash(route);
  if (window.location.hash !== nextHash) window.location.hash = nextHash;
}

export function ensureRoute(): void {
  if (!window.location.hash) window.history.replaceState(null, "", routeHash(readRoute()));
}
