import { AccessTab, Page } from "./model";

// Hash routes: #/worlds[/<game>[/<world>]], #/metrics[/<game>], #/console[/<game>],
// #/releases[/<game>], #/access/<tab>, #/profile. "overview" stays an alias of
// "worlds" so links from the bot and older bookmarks keep working.
export type AppRoute = Readonly<{ page: Page; accessTab: AccessTab; gameId: string | null; worldId: string | null }>;

export const LANDING_HASH = "#/";

// The front door lives at the bare root; every other hash is the console.
export function isLandingHash(hash: string = window.location.hash): boolean {
  const path = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return path === "" || path === "welcome";
}

const pageByPath: Record<string, Page> = {
  overview: "worlds",
  worlds: "worlds",
  metrics: "metrics",
  console: "console",
  releases: "releases",
  access: "access",
  profile: "profile",
};

const pathByPage: Record<Page, string> = {
  worlds: "worlds",
  metrics: "metrics",
  console: "console",
  releases: "releases",
  access: "access",
  profile: "profile",
};

const accessTabs = new Set<AccessTab>(["users", "roles", "notifications"]);

function segment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function readRoute(): AppRoute {
  const [pagePath = "worlds", second, third] = window.location.hash.replace(/^#\/?/, "").split("/");
  const page = pageByPath[pagePath] ?? "worlds";
  if (page === "access") {
    return { page, accessTab: accessTabs.has(second as AccessTab) ? (second as AccessTab) : "users", gameId: null, worldId: null };
  }
  if (page === "profile") return { page, accessTab: "users", gameId: null, worldId: null };
  return { page, accessTab: "users", gameId: segment(second), worldId: page === "worlds" ? segment(third) : null };
}

export function routeHash(route: AppRoute): string {
  const path = pathByPage[route.page];
  if (route.page === "access") return `#/${path}/${route.accessTab}`;
  if (route.page === "profile") return `#/${path}`;
  const parts = [path, route.gameId, route.page === "worlds" ? route.worldId : null]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map(encodeURIComponent);
  return `#/${parts.join("/")}`;
}

export function pushRoute(route: AppRoute): void {
  const nextHash = routeHash(route);
  if (window.location.hash !== nextHash) window.location.hash = nextHash;
}

export function replaceRoute(route: AppRoute): void {
  const nextHash = routeHash(route);
  if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
}

export function ensureRoute(): void {
  if (!window.location.hash) window.history.replaceState(null, "", routeHash(readRoute()));
}
