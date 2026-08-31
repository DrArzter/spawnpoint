export type CatalogWorld = Readonly<{
  id: string;
  displayName: string;
  profileId: string;
  // Whether the deployed session machines can operate this world. Since they
  // take a world id, that is every world in this catalog; the field stays for a
  // world listed before its host or profile exists.
  sessionControl: "v1" | null;
  // Which strategy publishes this world, mirroring server/worlds/catalog.json:
  // "zerotier" reaches players through the overlay, "raw" through whatever
  // public address the instance holds for that session.
  connectivity: "zerotier" | "raw";
}>;

export type CatalogGame = Readonly<{
  id: string;
  code: string;
  displayName: string;
  // The port a player types. The host part of an address belongs to the world's
  // connectivity strategy (ADR-0033); the port belongs to the game, and one
  // configured address string used to carry Minecraft's port for all of them.
  connectPort: number;
  worlds: readonly CatalogWorld[];
}>;

// This is deployment configuration, not observed runtime state. A world may be
// listed before it has a release pointer or an active session.
export const gameCatalog: readonly CatalogGame[] = [
  {
    id: "minecraft",
    code: "MC",
    displayName: "Minecraft",
    connectPort: 25565,
    worlds: [
      { id: "world", displayName: "Main modded", profileId: "main", sessionControl: "v1", connectivity: "zerotier" },
      { id: "vanilla", displayName: "Vanilla Forge", profileId: "vanilla-forge", sessionControl: "v1", connectivity: "zerotier" },
    ],
  },
  {
    id: "factorio",
    code: "FA",
    displayName: "Factorio",
    connectPort: 34197,
    worlds: [
      { id: "factorio", displayName: "Factorio vanilla", profileId: "factorio-vanilla", sessionControl: "v1", connectivity: "zerotier" },
    ],
  },
  {
    id: "zomboid",
    code: "PZ",
    displayName: "Project Zomboid",
    connectPort: 16261,
    worlds: [
      { id: "zomboid", displayName: "Project Zomboid vanilla", profileId: "zomboid-vanilla", sessionControl: "v1", connectivity: "zerotier" },
    ],
  },
];

// A world id is unique across games in this catalog, and the drift test against
// server/worlds/catalog.json keeps it that way.
export function connectPortForWorld(worldId: string, catalog: readonly CatalogGame[] = gameCatalog): number {
  const game = catalog.find((candidate) => candidate.worlds.some((world) => world.id === worldId));
  if (game === undefined) throw new Error(`unknown world: ${worldId}`);
  return game.connectPort;
}
