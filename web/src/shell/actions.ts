import type { Game, Preset, World } from "../model";

export type SessionAction = "start" | "stop";
export type WorldActionKind = "archive" | "wipe" | "restore" | "purge";

export type Pending =
  | { kind: "session"; worldId: string; action: SessionAction }
  | { kind: "lifecycle"; worldId: string; action: WorldActionKind }
  | { kind: "pack"; worldId: string }
  | { kind: "create" }
  | { kind: "refresh" };

export type Confirmation =
  | { kind: "session"; action: SessionAction; game: Game; world: World }
  | { kind: "archive"; game: Game; world: World }
  | { kind: "wipe"; game: Game; world: World; preset: Preset | null }
  | { kind: "restore"; game: Game; world: World; backupKey: string; backupName: string }
  | { kind: "purge"; game: Game; world: World };

export function pendingFor(pending: Pending | null, worldId: string): Pending | null {
  if (pending === null) return null;
  if ("worldId" in pending && pending.worldId === worldId) return pending;
  return null;
}
