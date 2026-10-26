import type { ReleaseMod, ReleaseMods } from "../api/contract";

/**
 * Every mod of a release once, in name order: the server's and, when players
 * install a set of their own (ADR-0069), theirs. A file both carry is one row.
 */
export function releaseModUnion(value: Pick<ReleaseMods, "mods" | "clientMods">): readonly ReleaseMod[] {
  const server = new Set(value.mods.map((mod) => mod.sha256));
  return [...value.mods, ...(value.clientMods ?? []).filter((mod) => !server.has(mod.sha256))]
    .sort((left, right) => left.file.localeCompare(right.file));
}
