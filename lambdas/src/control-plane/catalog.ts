import type { Footprint } from "../domain/placement.ts";
import type { PresetObservation } from "./preset-catalog.ts";
import type { WorldRecord } from "./world-registry.ts";
import { gameModules } from "./game-modules.ts";
import type { GamePresentation } from "../../../contract/control-plane.ts";

export type CatalogPreset = PresetObservation;

// What a session of each game needs from a host (ADR-0054), from its manifest:
// the container's hard memory limit and a core weight. A world may override its
// game's figure; a game with no module cannot be placed, which is the point.
export const gameFootprints: Readonly<Record<string, Footprint>> = Object.fromEntries(
  gameModules.map((module) => [module.id, module.footprint]),
);

// Which games may run on a Spot host (ADR-0102), from `capabilities.spot`.
export const gameSpot: Readonly<Record<string, boolean>> = Object.fromEntries(
  gameModules.map((module) => [module.id, module.spot]),
);

// The instance families a launch may draw from, as EC2 Fleet AllowedInstanceTypes
// patterns: a filter, never a ranking. ADR-0032 chose x86 for single-thread
// speed and the pool the presets were proven on; burstable and Graviton are out.
// Which of these a launch becomes is EC2's answer, by price, at launch time.
export const launchFamilies: readonly string[] = ["m7i-flex.*", "m7i.*", "r7i.*", "r8i-flex.*", "r8i.*", "c7i.*", "m7a.*", "r7a.*", "m6i.*", "r6i.*", "m6a.*", "r6a.*"];

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
  connectivity: "zerotier" | "raw" | "route53";
  placement?: "configured" | "fleet";
  materialization?: "existing" | "not_created" | "archived";
  preset?: Readonly<{
    id: string;
    repository: string;
    commit: string;
    profileDigest: string;
    releases: readonly string[];
    buildStatus: "unbuilt" | "building" | "ready" | "failed";
    latestRelease: string | null;
    olderReleases?: readonly string[];
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
  // The client fills in connectPort by itself, so an address on that port is
  // shown without it (Minecraft's 25565). Any other port stays in the address.
  portImplied?: true;
  // Replaces the entry in gameFootprints for this catalog; absent means that entry.
  footprint?: Footprint;
  // False for a game whose server tells its clients which port to continue on:
  // a slot's host mapping would send them to a port nothing listens on, so its
  // sessions take slot zero, where the ports are the game's own.
  slottable?: boolean;
  /** The game keeps a whitelist the host can write from a world's record (ADR-0066). */
  whitelist?: boolean;
  /** Its whitelist's player-name rule (ADR-0090). */
  playerName?: Readonly<{ pattern: string; hint: string }>;
  /** Commands its console offers to type. */
  consoleSuggestions?: readonly string[];
  /** How the skins draw it (ADR-0090). */
  presentation?: GamePresentation;
  presets?: readonly CatalogPreset[];
  worlds: readonly CatalogWorld[];
}>;

// Every game comes from its module's manifest (ADR-0088). Its worlds come from
// the world registry alone (ADR-0097): catalogWithPresets adds them.
export const gameCatalog: readonly CatalogGame[] = gameModules.map((module) => ({
  id: module.id,
  code: module.code,
  displayName: module.displayName,
  connectPort: module.connectPort,
  ...(module.portImplied ? { portImplied: true as const } : {}),
  ...(module.slottable ? {} : { slottable: false }),
  ...(module.whitelist ? { whitelist: true } : {}),
  ...(module.whitelist && module.whitelistRules !== null ? { playerName: { pattern: module.whitelistRules.namePattern.source, hint: module.whitelistRules.nameHint } } : {}),
  consoleSuggestions: module.console.suggestions,
  presentation: module.presentation,
  worlds: [],
}));

// Every world is a record in the registry (ADR-0097). Presets remain reusable
// templates in their own collection; they are never projected into fake
// not-yet-created worlds and are never consumed by world creation.
export function catalogWithPresets(
  presets: readonly PresetObservation[],
  catalog: readonly CatalogGame[] = gameCatalog,
  worldRecords: readonly WorldRecord[] = [],
): readonly CatalogGame[] {
  return catalog.map((game) => {
    const forGame = presets.filter((preset) => preset.gameId === game.id);
    const materialized = worldRecords
      .filter((record) => record.gameId === game.id)
      .map((record) => {
        const current = forGame.find((preset) => preset.id === record.preset.id && preset.profileDigest === record.preset.profileDigest);
        return {
          id: record.worldId,
          displayName: record.displayName,
          profileId: record.preset.id,
          sessionControl: record.status === "active" ? "v1" as const : null,
          connectivity: record.connectivity,
          placement: record.placement,
          materialization: record.status === "active" ? "existing" as const : "archived" as const,
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
            ...(current.olderReleases?.length ? { olderReleases: current.olderReleases } : {}),
          },
        };
      });
    return { ...game, presets: forGame, worlds: materialized };
  });
}

/** A world and its game, from whichever catalog the caller built: the built-in one, or with presets and the registry. */
export function findCatalogWorld(catalog: readonly CatalogGame[], gameId: string, worldId: string): Readonly<{ game: CatalogGame; world: CatalogWorld }> | null {
  const game = catalog.find((candidate) => candidate.id === gameId);
  const world = game?.worlds.find((candidate) => candidate.id === worldId);
  return game === undefined || world === undefined ? null : { game, world };
}

// Whether a session of this world must take slot zero: a public world, whose
// security group opens the game's own port only, and a world of a game that
// cannot be slotted. A world absent from the catalog given is pinned
// conservatively, because a public fleet world may use that same fixed port.
export function worldNeedsSlotZero(worldId: string, serverId?: string, catalog: readonly CatalogGame[] = gameCatalog): boolean {
  const game = catalog.find((candidate) => candidate.worlds.some((world) => world.id === worldId))
    ?? (serverId === undefined ? undefined : catalog.find((candidate) => candidate.id === serverId));
  if (game === undefined) return false;
  const world = game.worlds.find((candidate) => candidate.id === worldId);
  return game.slottable === false || world === undefined || world.connectivity === "raw" || world.connectivity === "route53";
}

// A world id is unique across games: the registry keys records by world id.
/** The address as players type it: without the port when it is the game's own and the client implies it. */
export function displayAddress(address: string, worldId: string, catalog: readonly CatalogGame[] = gameCatalog): string {
  const game = catalog.find((candidate) => candidate.worlds.some((world) => world.id === worldId));
  if (game?.portImplied !== true) return address;
  const suffix = `:${game.connectPort}`;
  return address.endsWith(suffix) ? address.slice(0, -suffix.length) : address;
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
  // A DNS record exists only for an observed ready session. The generic
  // deployment connectionHost is not this world's DNS name.
  if (world.connectivity === "route53") return null;
  const host = world.connectivity === "raw" ? answers.publicIp : answers.connectionHost;
  return host === null ? null : `${host}:${game.connectPort}`;
}
