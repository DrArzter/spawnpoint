import type { ReleaseMod, ReleaseMods } from "../api/contract";

/** Where one mod of a release goes (ADR-0069). */
export type ModSide = "both" | "server" | "players";

export const modSideLabels: Readonly<Record<ModSide, string>> = {
  both: "Server and players",
  server: "Server only",
  players: "Players only",
};

/**
 * Every mod of a release once, in name order, with the side it goes to. A
 * release without its own players set gives players the server's, so every
 * mod goes to both.
 */
export function releaseModSides(value: Pick<ReleaseMods, "mods" | "clientMods">): readonly (ReleaseMod & Readonly<{ side: ModSide }>)[] {
  if (value.clientMods === null) return value.mods.map((mod) => ({ ...mod, side: "both" }));
  const players = new Set(value.clientMods.map((mod) => mod.sha256));
  const server = new Set(value.mods.map((mod) => mod.sha256));
  const sided: (ReleaseMod & { side: ModSide })[] = [
    ...value.mods.map((mod) => ({ ...mod, side: players.has(mod.sha256) ? "both" as const : "server" as const })),
    ...value.clientMods.filter((mod) => !server.has(mod.sha256)).map((mod) => ({ ...mod, side: "players" as const })),
  ];
  return sided.sort((left, right) => left.file.localeCompare(right.file));
}
