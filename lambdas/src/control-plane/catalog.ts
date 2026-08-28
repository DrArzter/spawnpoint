export type CatalogWorld = Readonly<{
  id: string;
  displayName: string;
  profileId: string;
}>;

export type CatalogGame = Readonly<{
  id: string;
  code: string;
  displayName: string;
  worlds: readonly CatalogWorld[];
}>;

// This is deployment configuration, not observed runtime state. A world may be
// listed before it has a release pointer or an active session.
export const gameCatalog: readonly CatalogGame[] = [
  {
    id: "minecraft",
    code: "MC",
    displayName: "Minecraft",
    worlds: [
      { id: "world", displayName: "Main modded", profileId: "main" },
      { id: "vanilla", displayName: "Vanilla Forge", profileId: "vanilla-forge" },
    ],
  },
  {
    id: "factorio",
    code: "FA",
    displayName: "Factorio",
    worlds: [
      { id: "factorio", displayName: "Factorio vanilla", profileId: "factorio-vanilla" },
    ],
  },
];
