import type { LifecycleRecord } from "../domain/lifecycle.ts";

/*
 * Which lifecycle record a world's session lives on (ADR-0062). A world placed
 * on the fleet has a record of its own, so two worlds of one game run at once,
 * each on a host launched for it. A world on the configured host shares its
 * game's record: that one host runs one session at a time anyway.
 */

export type WorldPlacement = "configured" | "fleet";

const OWN_RECORD_PREFIX = "world#";

export function sessionLifecycleKey(gameId: string, worldId: string, placement: WorldPlacement): string {
  return placement === "fleet" ? `${OWN_RECORD_PREFIX}${worldId}` : gameId;
}

/** The record names this world, and is not fully at rest. */
export function holdsWorld(record: LifecycleRecord | null, worldId: string): boolean {
  return record !== null && record.activeWorldId === worldId &&
    (record.activeSessionId !== null || record.observedState !== "stopped");
}

export type WorldSession = Readonly<{
  /** The record's key, which every workflow carries as its `serverId`. */
  serverId: string;
  /** The record that holds this world's session, or that its next one will use. */
  record: LifecycleRecord | null;
}>;

/**
 * Where this world's session is now. A fleet world's own record, unless its
 * game's record still holds it: a session begun before fleet worlds had
 * records of their own runs to its stop on the record it began on.
 */
export function locateWorldSession(
  gameId: string,
  worldId: string,
  placement: WorldPlacement,
  records: Readonly<{ game: LifecycleRecord | null; own: LifecycleRecord | null }>,
): WorldSession {
  if (placement !== "fleet") {
    // A record from before sessions named their world cannot say whose it is.
    const unnamed = records.game !== null && records.game.activeWorldId == null && records.game.activeSessionId !== null;
    return { serverId: gameId, record: holdsWorld(records.game, worldId) || unnamed ? records.game : null };
  }
  const own = sessionLifecycleKey(gameId, worldId, placement);
  if (!holdsWorld(records.own, worldId) && holdsWorld(records.game, worldId)) return { serverId: gameId, record: records.game };
  return { serverId: own, record: records.own };
}

export type AttributedOperation = Readonly<{ worldId: string | null }>;

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The world a session workflow's input names, or null for anything else. */
export function operationWorldId(input: string | undefined): string | null {
  if (input === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== "object" || !("worldId" in parsed)) return null;
    const worldId = (parsed as { worldId: unknown }).worldId;
    return typeof worldId === "string" && WORLD_ID.test(worldId) ? worldId : null;
  } catch {
    return null;
  }
}

/**
 * The running operations that rule out a new one on this world. Anything not
 * attributed to a world blocks everything, as every operation once did. A
 * fleet world is held up only by its own operations; a configured world by any
 * operation on the configured host, which its worlds share.
 */
export function blockingOperations<Operation extends AttributedOperation>(
  operations: readonly Operation[],
  worldId: string,
  placementOf: (worldId: string) => WorldPlacement | undefined,
): Operation[] {
  const placement = placementOf(worldId) ?? "configured";
  return operations.filter((operation) => {
    if (operation.worldId === null || operation.worldId === worldId) return true;
    return placement === "configured" && (placementOf(operation.worldId) ?? "configured") === "configured";
  });
}

export type WorldHost = Readonly<{ hostId: string; slot: string }>;

/**
 * The host a world runs on now, and its slot there (ADR-0062, ADR-0063). A
 * world without a session runs nowhere, even when its game's configured host
 * runs another of its worlds: that load is not this world's. A placed session
 * names its host and slot; an unplaced session of a configured world runs
 * unslotted on the one configured host.
 */
export function worldHost(
  placement: WorldPlacement,
  session: LifecycleRecord | null,
  placed: Readonly<{ hostId: string; slot: number }> | null,
  configuredHostIds: readonly string[],
): WorldHost | null {
  if (!session?.activeSessionId) return null;
  if (placed !== null) return { hostId: placed.hostId, slot: String(placed.slot) };
  if (placement !== "configured" || configuredHostIds.length !== 1) return null;
  return { hostId: configuredHostIds[0]!, slot: "" };
}
