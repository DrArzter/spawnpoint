import { type WorldPlacement, sessionLifecycleKey, locateWorldSession, type WorldSession, type WorldHost, worldHost } from "../../control-plane/world-session.ts";
import { awsControlPlaneSources, findSessionPlacement, readWorldRecord } from "../../control-plane/aws.ts";
import { catalogWithPresets, gameCatalog } from "../../control-plane/catalog.ts";

// The record a world's session lives on: a fleet world's own, or its game's
// (ADR-0062). Both are read for a fleet world, because a session begun under the
// game's record before fleet worlds had their own still runs to its stop there.
export async function readWorldSession(gameId: string, worldId: string, placement: WorldPlacement) {
  const [game, own] = await Promise.all([
    awsControlPlaneSources.readLifecycle(gameId),
    placement === "fleet" ? awsControlPlaneSources.readLifecycle(sessionLifecycleKey(gameId, worldId, placement)) : Promise.resolve(null),
  ]);
  return { ...locateWorldSession(gameId, worldId, placement, { game, own }), game };
}

export function worldPlacements(catalog: ReturnType<typeof catalogWithPresets>): (worldId: string) => WorldPlacement | undefined {
  const placements = new Map(catalog.flatMap((game) => game.worlds.map((world) => [world.id, world.placement ?? "configured"] as const)));
  return (worldId) => placements.get(worldId);
}

// --- What runs a world: its host (ADR-0062, ADR-0063) ---------------------------
export async function locateWorldHost(
  placement: WorldPlacement,
  session: WorldSession["record"],
  hosts: readonly Readonly<{ providerRef: string; provenance?: "configured" | "launched" }>[],
): Promise<WorldHost | null> {
  const placed = session?.activeSessionId ? await findSessionPlacement(session.activeSessionId) : null;
  const configured = hosts.filter((host) => host.provenance !== "launched").map((host) => host.providerRef);
  return worldHost(placement, session, placed, configured);
}

// Whether the world exists for this game: a legacy world in the static
// catalog, or a world record.
export async function knownWorld(gameId: string, worldId: string): Promise<boolean> {
  if (gameCatalog.find((game) => game.id === gameId)?.worlds.some((candidate) => candidate.id === worldId)) return true;
  return (await readWorldRecord(worldId))?.gameId === gameId;
}
