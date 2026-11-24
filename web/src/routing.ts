import type { AccessTab, Page, WorldTab } from "./model";

// Hash routes: #/worlds[/<game>[/<world>[/<tab>]]], #/home[/<game>], #/metrics[/<game>],
// #/console[/<game>], #/releases[/<game>], #/access/<tab>, #/profile. "overview" stays
// an alias of "worlds" so links from the bot and older bookmarks keep working.
// #/home is the worlds page as a game's overview, for a skin that draws one.
export type WorldsView = "overview" | "list";
export type AppRoute = Readonly<{ page: Page; accessTab: AccessTab; gameId: string | null; worldId: string | null; worldTab: WorldTab; worldsView: WorldsView }>;

export const LANDING_HASH = "#/";

export type EmailActionRoute = Readonly<{ kind: "verify-email" | "reset-password"; token: string; invitationToken: string | null }>;

export type AccessInvitationRoute = Readonly<{ token: string; proof: string | null }>;

export function readAccessInvitationRoute(hash: string = window.location.hash): AccessInvitationRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  if (path !== "join") return null;
  const parameters = new URLSearchParams(query);
  return { token: parameters.get("token") ?? "", proof: parameters.get("proof") };
}

export function readEmailActionRoute(hash: string = window.location.hash): EmailActionRoute | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  if (path !== "verify-email" && path !== "reset-password") return null;
  const parameters = new URLSearchParams(query);
  return { kind: path, token: parameters.get("token") ?? "", invitationToken: parameters.get("invite") };
}

export function readMcpConnectRoute(hash: string = window.location.hash): string | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  if (path !== "connect") return null;
  return new URLSearchParams(query).get("request")?.trim() || null;
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
  home: "worlds",
  // Console and metrics were game pages before they became a world's tabs;
  // an old link lands on the worlds it was about.
  metrics: "worlds",
  console: "worlds",
  releases: "releases",
  access: "access",
  profile: "profile",
};

const pathByPage: Record<Page, string> = {
  worlds: "worlds",
  releases: "releases",
  access: "access",
  profile: "profile",
};

const accessTabs = new Set<AccessTab>(["users", "roles", "notifications"]);
/** The world page tabs, in the order the tab bar shows them. */
const WORLD_TAB_ORDER: readonly WorldTab[] = ["details", "wipes", "backups", "releases", "whitelist", "config", "console", "log", "metrics"];
const worldTabs = new Set<WorldTab>(WORLD_TAB_ORDER);

function segment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// The rail's order. Between two pages of one depth, the one further down the
// rail is "after" the other, so a page switch can tell which way it travels.
const SECTION_ORDER = ["home", "worlds", "releases", "access", "profile"] as const;

/**
 * Where an address sits in the console's hierarchy: its depth (a world is one
 * level below its game's pages) and its section's place on the rail. An
 * address of no known section sits with the worlds.
 */
export function placeOf(hash: string): Readonly<{ depth: number; section: number }> {
  const [path = "", , world = ""] = hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  const section = SECTION_ORDER.indexOf(path === "home" ? "home" : (pageByPath[path] ?? "worlds"));
  return { depth: path === "worlds" && world !== "" ? 1 : 0, section };
}

export type Traverse = "forward" | "back" | "none";

/**
 * Which way a page switch travels. Going deeper (a list to one of its items) is
 * forward; going up, or to an earlier section of the same depth, is back; two
 * pages of one depth and section (another game's worlds) have no direction.
 */
export function traverse(from: string, to: string): Traverse {
  const before = placeOf(from);
  const after = placeOf(to);
  const order = after.depth - before.depth || after.section - before.section;
  if (order === 0) return "none";
  return order > 0 ? "forward" : "back";
}

/**
 * A pane switch inside one world follows the tab bar: a tab to the right comes
 * in from the right. Another world, or the same tab, has no direction.
 */
export function tabTraverse(from: string, to: string): Traverse {
  const tab = (hash: string) => {
    const [, , world, name] = hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
    return { world, index: WORLD_TAB_ORDER.indexOf(worldTabs.has(name as WorldTab) ? (name as WorldTab) : "details") };
  };
  const before = tab(from);
  const after = tab(to);
  if (before.world !== after.world || before.index === after.index) return "none";
  return after.index > before.index ? "forward" : "back";
}

export function readRoute(): AppRoute {
  const [pagePath = "worlds", second, third, fourth] = window.location.hash.replace(/^#\/?/, "").split("/");
  const page = pageByPath[pagePath] ?? "worlds";
  if (page === "access") {
    return { page, accessTab: accessTabs.has(second as AccessTab) ? (second as AccessTab) : "users", gameId: null, worldId: null, worldTab: "details", worldsView: "list" };
  }
  if (page === "profile") return { page, accessTab: "users", gameId: null, worldId: null, worldTab: "details", worldsView: "list" };
  if (pagePath === "home") return { page, accessTab: "users", gameId: segment(second), worldId: null, worldTab: "details", worldsView: "overview" };
  return {
    page,
    accessTab: "users",
    gameId: segment(second),
    worldId: page === "worlds" ? segment(third) : null,
    worldTab: page === "worlds" && worldTabs.has(fourth as WorldTab) ? (fourth as WorldTab) : "details",
    worldsView: "list",
  };
}

// The tab and the view are optional here: most links name a page, and a link
// that names neither means the world's first tab or the list of worlds.
export function routeHash(route: Omit<AppRoute, "worldTab" | "worldsView"> & { worldTab?: WorldTab; worldsView?: WorldsView }): string {
  const path = pathByPage[route.page];
  if (route.page === "access") return `#/${path}/${route.accessTab}`;
  if (route.page === "profile") return `#/${path}`;
  if (route.page === "worlds" && !route.worldId && route.worldsView === "overview") {
    return route.gameId ? `#/home/${encodeURIComponent(route.gameId)}` : "#/home";
  }
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
