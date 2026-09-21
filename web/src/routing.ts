import { AccessTab, Page, WorldTab } from "./model";

// Hash routes: #/worlds[/<game>[/<world>[/<tab>]]], #/metrics[/<game>], #/console[/<game>],
// #/releases[/<game>], #/access/<tab>, #/profile. "overview" stays an alias of
// "worlds" so links from the bot and older bookmarks keep working.
export type AppRoute = Readonly<{ page: Page; accessTab: AccessTab; gameId: string | null; worldId: string | null; worldTab: WorldTab }>;

export const LANDING_HASH = "#/";

export type EmailActionRoute = Readonly<{ kind: "verify-email" | "reset-password"; token: string }>;

export function readEmailActionRoute(hash: string = window.location.hash): EmailActionRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  if (path !== "verify-email" && path !== "reset-password") return null;
  return { kind: path, token: new URLSearchParams(query).get("token") ?? "" };
}

// The front door lives at the bare root; every other hash is the console.
export function isLandingHash(hash: string = window.location.hash): boolean {
  const path = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return path === "" || path === "welcome";
}

// The bare root is the one address a signed-in arrival is redirected away from.
// `#/welcome` is the front door on purpose, so it always renders.
export function isRootHash(hash: string = window.location.hash): boolean {
  return (hash.replace(/^#\/?/, "").split("/")[0] ?? "") === "";
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
const worldTabs = new Set<WorldTab>(["details", "wipes", "backups", "releases"]);

function segment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function readRoute(): AppRoute {
  const [pagePath = "worlds", second, third, fourth] = window.location.hash.replace(/^#\/?/, "").split("/");
  const page = pageByPath[pagePath] ?? "worlds";
  if (page === "access") {
    return { page, accessTab: accessTabs.has(second as AccessTab) ? (second as AccessTab) : "users", gameId: null, worldId: null, worldTab: "details" };
  }
  if (page === "profile") return { page, accessTab: "users", gameId: null, worldId: null, worldTab: "details" };
  return {
    page,
    accessTab: "users",
    gameId: segment(second),
    worldId: page === "worlds" ? segment(third) : null,
    worldTab: page === "worlds" && worldTabs.has(fourth as WorldTab) ? (fourth as WorldTab) : "details",
  };
}

// The tab is optional here: most links name a page, and a link that does not
// name a tab means the one a world opens on.
export function routeHash(route: Omit<AppRoute, "worldTab"> & { worldTab?: WorldTab }): string {
  const path = pathByPage[route.page];
  if (route.page === "access") return `#/${path}/${route.accessTab}`;
  if (route.page === "profile") return `#/${path}`;
  const worldTab = route.page === "worlds" && route.worldId && route.worldTab !== "details" ? route.worldTab : null;
  const parts = [path, route.gameId, route.page === "worlds" ? route.worldId : null, worldTab]
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
