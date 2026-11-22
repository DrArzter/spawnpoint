import { manifestClientMods, manifestServerMods, MOD_SOURCES, type ManifestMod, type ModSource } from "./release-artifacts.ts";

export const MOD_PAGE_SIZE_DEFAULT = 50;
export const MOD_PAGE_SIZE_MAX = 200;
const SEARCH_MAX = 100;

export const MOD_SORTS = ["name", "source", "size"] as const;
export type ModSort = (typeof MOD_SORTS)[number];
/** `unknown` is a mod whose release did not record where it came from. */
export type ModSourceFilter = ModSource | "unknown";

export type ModListQuery = Readonly<{
  search: string;
  source: ModSourceFilter | null;
  sort: ModSort;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}>;

export type ModListParse = Readonly<{ kind: "none" }> | Readonly<{ kind: "invalid" }> | Readonly<{ kind: "query"; query: ModListQuery }>;

const PARAMETERS = new Set(["query", "source", "sort", "order", "page", "pageSize"]);
const INTEGER = /^[0-9]{1,6}$/;

function integer(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  return INTEGER.test(value) ? Number(value) : null;
}

/**
 * No parameter at all is the whole manifest (the MCP tool reads it so); any
 * parameter asks for one page. An unknown name or an out-of-range value is
 * refused rather than guessed.
 */
export function parseModListQuery(raw: Readonly<Record<string, string | undefined>> | undefined): ModListParse {
  const entries = Object.entries(raw ?? {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return { kind: "none" };
  if (entries.some(([key]) => !PARAMETERS.has(key))) return { kind: "invalid" };
  const { query, source, sort, order } = raw ?? {};
  const page = integer(raw?.page, 1);
  const pageSize = integer(raw?.pageSize, MOD_PAGE_SIZE_DEFAULT);
  const search = (query ?? "").trim();
  if (page === null || page < 1 || pageSize === null || pageSize < 1 || pageSize > MOD_PAGE_SIZE_MAX || search.length > SEARCH_MAX) return { kind: "invalid" };
  if (source !== undefined && source !== "unknown" && !(MOD_SOURCES as readonly string[]).includes(source)) return { kind: "invalid" };
  if (sort !== undefined && !(MOD_SORTS as readonly string[]).includes(sort)) return { kind: "invalid" };
  if (order !== undefined && order !== "asc" && order !== "desc") return { kind: "invalid" };
  return {
    kind: "query",
    query: { search, source: (source as ModSourceFilter | undefined) ?? null, sort: (sort as ModSort | undefined) ?? "name", order: order ?? "asc", page, pageSize },
  };
}

/** Every mod of a release once: the server's and, when players install a set of their own (ADR-0069), theirs. A file both carry is one row. */
function modUnion(manifest: unknown): Readonly<{ mods: readonly ManifestMod[]; split: boolean }> {
  const server = manifestServerMods(manifest);
  const client = manifestClientMods(manifest);
  const held = new Set(server.map((mod) => mod.sha256));
  return { mods: [...server, ...(client ?? []).filter((mod) => !held.has(mod.sha256))], split: client !== null };
}

const sourceRank = (source: ModSource | undefined): number => source === undefined ? MOD_SOURCES.length : MOD_SOURCES.indexOf(source);
const byName = (left: ManifestMod, right: ManifestMod): number => left.file.localeCompare(right.file, "en") || left.sha256.localeCompare(right.sha256);

const orders: Readonly<Record<ModSort, (left: ManifestMod, right: ManifestMod) => number>> = {
  name: byName,
  source: (left, right) => sourceRank(left.source) - sourceRank(right.source),
  size: (left, right) => left.bytes - right.bytes,
};

/** One page of a release's mods, with what a list needs around it: totals, the sources it holds and whether players install their own set. */
export function releaseModPage(manifest: unknown, query: ModListQuery) {
  const { mods, split } = modUnion(manifest);
  const sources = [...MOD_SOURCES, undefined]
    .map((source) => ({ source: source ?? "unknown", count: mods.filter((mod) => mod.source === source).length }))
    .filter((entry) => entry.count > 0);
  const needle = query.search.toLowerCase();
  const sign = query.order === "asc" ? 1 : -1;
  const matching = mods
    .filter((mod) => needle === "" || mod.file.toLowerCase().includes(needle))
    .filter((mod) => query.source === null || (mod.source ?? "unknown") === query.source)
    .sort((left, right) => sign * orders[query.sort](left, right) || byName(left, right));
  const pages = Math.max(1, Math.ceil(matching.length / query.pageSize));
  const page = Math.min(query.page, pages);
  return {
    split,
    all: mods.length,
    total: matching.length,
    page,
    pageSize: query.pageSize,
    pages,
    // Only a release that recorded sources offers the filter.
    sources: sources.length === 1 && sources[0]?.source === "unknown" ? [] : sources,
    mods: matching.slice((page - 1) * query.pageSize, page * query.pageSize),
  };
}
