export type CatalogWorld = Readonly<{
  id: string;
  displayName: string;
  profileId: string;
  // Whether the deployed session machines can operate this world. Since they
  // take a world id, that is every world in this catalog; the field stays for a
  // world listed before its host or profile exists.
  sessionControl: "v1" | null;
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
      { id: "world", displayName: "Main modded", profileId: "main", sessionControl: "v1" },
      { id: "vanilla", displayName: "Vanilla Forge", profileId: "vanilla-forge", sessionControl: "v1" },
    ],
  },
  {
    id: "factorio",
    code: "FA",
    displayName: "Factorio",
    worlds: [
      { id: "factorio", displayName: "Factorio vanilla", profileId: "factorio-vanilla", sessionControl: "v1" },
    ],
  },
  {
    id: "zomboid",
    code: "PZ",
    displayName: "Project Zomboid",
    worlds: [
      { id: "zomboid", displayName: "Project Zomboid vanilla", profileId: "zomboid-vanilla", sessionControl: "v1" },
    ],
  },
];
