import type { ModSortKey, ModSource, ModSourceFilter, ReleaseModPage, ReleaseModQuery } from "../api/contract";
import { t } from "../i18n";

/** The sources a mod can come from, in the order a list offers them. */
export const MOD_SOURCES: readonly Readonly<{ id: ModSource; label: string }>[] = [
  { id: "curseforge", label: "CurseForge" },
  { id: "modrinth", label: "Modrinth" },
  { id: "github", label: "GitHub" },
];

/** What a list says of a mod whose release did not record where it came from. */
export const UNKNOWN_SOURCE = t("common.unknown");

export function modSourceLabel(source: ModSource | null): string {
  return MOD_SOURCES.find((item) => item.id === source)?.label ?? UNKNOWN_SOURCE;
}

/** The mods a page asks for at once, and how long a search waits for the next key before it asks. */
export const MOD_PAGE_SIZE = 50;
export const MOD_SEARCH_DELAY_MS = 300;

export type ModSortDirection = "ascending" | "descending";

/** What a person has chosen on the list; the server turns it into one page. */
export type ModsView = Readonly<{
  /** The text in the search field. */
  search: string;
  /** The search the page was last asked with; it follows `search` after a pause. */
  applied: string;
  source: ModSourceFilter | null;
  sort: Readonly<{ key: ModSortKey; direction: ModSortDirection }>;
  page: number;
}>;

export const FRESH_MODS_VIEW: ModsView = { search: "", applied: "", source: null, sort: { key: "name", direction: "ascending" }, page: 1 };

export function modListQuery(view: ModsView): ReleaseModQuery {
  return {
    search: view.applied.trim(),
    source: view.source,
    sort: view.sort.key,
    order: view.sort.direction === "ascending" ? "asc" : "desc",
    page: view.page,
    pageSize: MOD_PAGE_SIZE,
  };
}

/** The sources a release holds with the words a filter shows, in the order a list offers them, unknown last. */
export function modSourceEntries(sources: ReleaseModPage["sources"]): readonly Readonly<{ source: ModSourceFilter; label: string; count: number }>[] {
  const rank = (source: ModSourceFilter) => source === "unknown" ? MOD_SOURCES.length : MOD_SOURCES.findIndex((item) => item.id === source);
  return [...sources]
    .sort((left, right) => rank(left.source) - rank(right.source))
    .map(({ source, count }) => ({ source, count, label: source === "unknown" ? UNKNOWN_SOURCE : modSourceLabel(source) }));
}
