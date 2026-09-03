import type { PresetObservation } from "./preset-catalog.ts";
import type { WorldRecord } from "./world-registry.ts";

export type CatalogPreset = PresetObservation;

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
  materialization?: "existing" | "not_created" | "archived";
  worldLifecycle?: "v1" | null;
  preset?: Readonly<{
    id: string;
    repository: string;
    commit: string;
    profileDigest: string;
    releases: readonly string[];
    buildStatus: "unbuilt" | "building" | "ready" | "failed";
    latestRelease: string | null;
  }>;
}>;

export type CatalogGame = Readonly<{
  id: string;
  code: string;
  displayName: string;
  // The port a player types. The host part of an address belongs to the world's
  // connectivity strategy (ADR-0033); the port belongs to the game, and one
  // configured address string used to carry Minecraft's port for all of them.
  connectPort: number;
  presets?: readonly CatalogPreset[];
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
    worlds: [],
  },
  {
    id: "zomboid",
    code: "PZ",
    displayName: "Project Zomboid",
    connectPort: 16261,
    worlds: [],
  },
];

// Static entries preserve every already managed legacy world. Presets remain
// reusable templates in their own collection; they are never projected into
// fake not-yet-created worlds and are never consumed by world creation.
export function catalogWithPresets(
  presets: readonly PresetObservation[],
  catalog: readonly CatalogGame[] = gameCatalog,
  worldRecords: readonly WorldRecord[] = [],
): readonly CatalogGame[] {
  return catalog.map((game) => {
    const forGame = presets.filter((preset) => preset.gameId === game.id);
    const existing = game.worlds.map((world) => {
      const preset = forGame.find((candidate) => candidate.id === world.profileId);
      if (preset === undefined) return { ...world, materialization: "existing" as const, worldLifecycle: null };
      return {
        ...world,
        displayName: preset.displayName,
        materialization: "existing" as const,
        worldLifecycle: null,
        preset: {
          id: preset.id,
          repository: preset.repository,
          commit: preset.commit,
          profileDigest: preset.profileDigest,
          releases: preset.releases,
          buildStatus: preset.buildStatus,
          latestRelease: preset.latestRelease,
        },
      };
    });
    const materialized = worldRecords
      .filter((record) => record.gameId === game.id)
      .filter((record) => !existing.some((world) => world.id === record.worldId))
      .map((record) => {
        const current = forGame.find((preset) => preset.id === record.preset.id && preset.profileDigest === record.preset.profileDigest);
        return {
          id: record.worldId,
          displayName: record.displayName,
          profileId: record.preset.id,
          sessionControl: record.status === "active" ? "v1" as const : null,
          connectivity: record.connectivity,
          materialization: record.status === "active" ? "existing" as const : "archived" as const,
          worldLifecycle: "v1" as const,
          preset: current === undefined ? {
            id: record.preset.id,
            repository: record.preset.repository,
            commit: record.preset.commit,
            profileDigest: record.preset.profileDigest,
            releases: [record.currentGeneration.release],
            buildStatus: "ready" as const,
            latestRelease: record.currentGeneration.release,
          } : {
            id: current.id,
            repository: current.repository,
            commit: current.commit,
            profileDigest: current.profileDigest,
            releases: current.releases,
            buildStatus: current.buildStatus,
            latestRelease: current.latestRelease,
          },
        };
      });
    return { ...game, presets: forGame, worlds: [...existing, ...materialized] };
  });
}

// A world id is unique across games in this catalog, and the drift test against
// server/worlds/catalog.json keeps it that way.
export function connectPortForWorld(worldId: string, catalog: readonly CatalogGame[] = gameCatalog): number {
  const game = catalog.find((candidate) => candidate.worlds.some((world) => world.id === worldId));
  if (game === undefined) throw new Error(`unknown world: ${worldId}`);
  return game.connectPort;
}

// The address a player types, composed here exactly as the host composes it:
// the strategy answers with the host part and the game with the port. Null when
// the strategy has no answer — an overlay address withheld from a caller who
// may not read one, or a public address that exists only while the instance
// runs. Nothing stores an address; each surface asks this function.
export function worldAddress(
  worldId: string,
  answers: Readonly<{ connectionHost: string | null; publicIp: string | null }>,
  catalog: readonly CatalogGame[] = gameCatalog,
): string | null {
  const game = catalog.find((candidate) => candidate.worlds.some((world) => world.id === worldId));
  const world = game?.worlds.find((candidate) => candidate.id === worldId);
  if (game === undefined || world === undefined) throw new Error(`unknown world: ${worldId}`);
  if (answers.connectionHost === null) return null;
  const host = world.connectivity === "raw" ? answers.publicIp : answers.connectionHost;
  return host === null ? null : `${host}:${game.connectPort}`;
}
