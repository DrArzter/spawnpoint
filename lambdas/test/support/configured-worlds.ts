import { createHash } from "node:crypto";

import { gameCatalog, type CatalogGame } from "../../src/control-plane/catalog.ts";
import type { ControlPlaneSources } from "../../src/control-plane/read-model.ts";
import type { WorldRecord } from "../../src/control-plane/world-registry.ts";

/** A catalog with two configured Minecraft worlds, as the registry lists them (ADR-0097). */
export const configuredCatalog: readonly CatalogGame[] = gameCatalog.map((game) => game.id !== "minecraft" ? game : {
  ...game,
  worlds: [
    { id: "world", displayName: "Main modded", profileId: "main", sessionControl: "v1", connectivity: "zerotier", placement: "configured" },
    { id: "vanilla", displayName: "Vanilla Forge", profileId: "vanilla-forge", sessionControl: "v1", connectivity: "zerotier", placement: "configured" },
  ],
});

const hex = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);

/** The registry records that list a test catalog's worlds: the catalog lists only what records say. */
export function recordsFor(catalog: readonly CatalogGame[]): WorldRecord[] {
  return catalog.flatMap((game) => game.worlds.map((world): WorldRecord => ({
    worldId: world.id,
    gameId: game.id,
    displayName: world.displayName,
    status: world.materialization === "archived" ? "archived" : "active",
    placement: world.placement ?? (world.connectivity === "zerotier" ? "configured" : "fleet"),
    connectivity: world.connectivity,
    ...(world.connectivity === "zerotier" ? {} : { auth: "game" as const }),
    preset: { id: world.profileId, repository: "https://github.com/example/presets", commit: hex(`${world.id}-commit`, 40), profileDigest: hex(`${world.id}-digest`, 64) },
    currentGeneration: { id: `gen-${hex(world.id, 32)}`, release: "1.0", createdAt: "2026-08-01T00:00:00.000Z", source: { kind: "preset" } },
    previousGenerations: [],
  })));
}

/** The sources, with the records of the catalog's worlds beside the ones they already list. */
export function withRecords(sources: ControlPlaneSources, catalog: readonly CatalogGame[]): ControlPlaneSources {
  return {
    ...sources,
    listWorldRecords: async () => {
      const own = await (sources.listWorldRecords?.() ?? Promise.resolve([]));
      return [...own, ...recordsFor(catalog).filter((record) => !own.some((item) => item.worldId === record.worldId))];
    },
  };
}
