import type { Game, Preset, World } from "../model";

export type SessionAction = "start" | "stop";
export type WorldActionKind = "archive" | "wipe" | "restore" | "purge";

export type Pending =
  | { kind: "session"; worldId: string; action: SessionAction }
  | { kind: "lifecycle"; worldId: string; action: WorldActionKind }
  | { kind: "promote"; worldId: string }
  | { kind: "pack"; worldId: string }
  | { kind: "create" }
  | { kind: "build"; presetId: string }
  | { kind: "refresh" };

export type Confirmation =
  | { kind: "build"; game: Game; preset: Preset }
  | { kind: "session"; action: SessionAction; game: Game; world: World; disconnect?: number }
  | { kind: "archive"; game: Game; world: World }
  | { kind: "wipe"; game: Game; world: World; preset: Preset | null }
  | { kind: "restore"; game: Game; world: World; backupKey: string; backupName: string; release: string | null }
  | { kind: "purge"; game: Game; world: World }
  | { kind: "promote"; game: Game; world: World; preset: Preset | null }
  | { kind: "delete-host"; host: Readonly<{ providerRef: string; name: string }> };

/** What is in flight: one slot per world, and one per kind that names no world, so one request never clears another's. */
export type PendingMap = Readonly<Record<string, Pending>>;

export const NO_PENDING: PendingMap = {};

function pendingKey(pending: Pending): string {
  return "worldId" in pending ? `world:${pending.worldId}` : pending.kind;
}

export function withPending(map: PendingMap, pending: Pending): PendingMap {
  return { ...map, [pendingKey(pending)]: pending };
}

/** Clears the slot only while it still holds this request. */
export function withoutPending(map: PendingMap, pending: Pending): PendingMap {
  const key = pendingKey(pending);
  if (map[key] !== pending) return map;
  const { [key]: _cleared, ...rest } = map;
  return rest;
}

export function pendingFor(pending: PendingMap, worldId: string): Pending | null {
  return pending[`world:${worldId}`] ?? null;
}

export function pendingOf<Kind extends "create" | "build" | "refresh">(pending: PendingMap, kind: Kind): Extract<Pending, { kind: Kind }> | null {
  return (pending[kind] as Extract<Pending, { kind: Kind }> | undefined) ?? null;
}

/** A session or world request in flight on any of these worlds. */
export function controlPending(pending: PendingMap, worlds: readonly World[]): boolean {
  return worlds.some((world) => {
    const item = pendingFor(pending, world.id);
    return item?.kind === "session" || item?.kind === "lifecycle";
  });
}
