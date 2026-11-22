import type { ModSource, ReleaseMod, ReleaseMods } from "../api/contract";
import type { ModRow } from "./models";

/**
 * Every mod of a release once, in name order: the server's and, when players
 * install a set of their own (ADR-0069), theirs. A file both carry is one row.
 */
export function releaseModUnion(value: Pick<ReleaseMods, "mods" | "clientMods">): readonly ReleaseMod[] {
  const server = new Set(value.mods.map((mod) => mod.sha256));
  return [...value.mods, ...(value.clientMods ?? []).filter((mod) => !server.has(mod.sha256))]
    .sort((left, right) => left.file.localeCompare(right.file));
}

/** The sources a mod can come from, in the order a list offers them. */
export const MOD_SOURCES: readonly Readonly<{ id: ModSource; label: string }>[] = [
  { id: "curseforge", label: "CurseForge" },
  { id: "modrinth", label: "Modrinth" },
  { id: "github", label: "GitHub" },
];

/** What a list says of a mod whose release did not record where it came from. */
export const UNKNOWN_SOURCE = "Unknown";

export function modSourceLabel(source: ModSource | null): string {
  return MOD_SOURCES.find((item) => item.id === source)?.label ?? UNKNOWN_SOURCE;
}

/** The sources the rows hold and how many rows hold each, unknown last. Empty when no row names a source. */
export function modSourceCounts(rows: readonly Pick<ModRow, "source">[]): readonly Readonly<{ source: ModSource | null; label: string; count: number }>[] {
  if (rows.every((row) => row.source === null)) return [];
  return [...MOD_SOURCES.map((item) => item.id), null]
    .map((source) => ({ source, label: modSourceLabel(source), count: rows.filter((row) => row.source === source).length }))
    .filter((entry) => entry.count > 0);
}

export type ModSortKey = "name" | "source" | "size";

const sourceRank = (source: ModSource | null): number => source === null ? MOD_SOURCES.length : MOD_SOURCES.findIndex((item) => item.id === source);

const byName = (left: ModRow, right: ModRow): number => left.file.localeCompare(right.file);

const modOrders: Readonly<Record<ModSortKey, (left: ModRow, right: ModRow) => number>> = {
  name: byName,
  source: (left, right) => sourceRank(left.source) - sourceRank(right.source),
  size: (left, right) => left.bytes - right.bytes,
};

/** The rows in the order a column asks for; equal rows keep name order, also when the sort is descending. */
export function sortMods(rows: readonly ModRow[], key: ModSortKey, direction: "ascending" | "descending"): ModRow[] {
  const sign = direction === "ascending" ? 1 : -1;
  return [...rows].sort((left, right) => sign * modOrders[key](left, right) || byName(left, right));
}
