// Switch the release of a wipe that never started (ADR-0078, amended).
// Nothing runs and nothing is saved, so there is no backup and no workflow:
// two conditional writes move the release the wipe will first start on.

import type { ReleaseHolders, WorldIdentity } from "./release-holders.ts";
import type { ReleaseState } from "./release-state.ts";
import type { WorldRecord } from "./world-registry.ts";

export type SwitchPorts = Readonly<{
  holders: Pick<ReleaseHolders, "hold">;
  pointers: Readonly<{
    read: (ref: Readonly<{ worldId: string; generationId: string }>) => Promise<Readonly<{ state: ReleaseState; etag: string }> | null>;
    replace: (state: ReleaseState, etag: string) => Promise<void>;
  }>;
  worlds: Readonly<{
    read: (worldId: string) => Promise<Readonly<{ record: WorldRecord; etag: string }> | null>;
    replace: (record: WorldRecord, etag: string) => Promise<void>;
  }>;
  now: () => Date;
}>;

export type SwitchRequest = Readonly<{ worldId: string; generationId: string; release: string; updatedBy: string }>;

/** `conflict`: the wipe or its record changed since the plan, or started. Nothing is left half done that a repeat cannot finish. */
export type SwitchOutcome = "switched" | "conflict";

export function isPreconditionFailed(error: unknown): boolean {
  return error instanceof Error && (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

/** The wipe has not started: no active release, no run, and it came from the preset, not from a backup. */
export function neverStarted(state: ReleaseState, record: WorldRecord, generationId: string): boolean {
  return state.generationId === generationId && state.activeRelease === null && (state.releasesRun ?? []).length === 0 &&
    record.currentGeneration.id === generationId && record.currentGeneration.source.kind === "preset";
}

async function write(write: () => Promise<void>): Promise<SwitchOutcome> {
  try {
    await write();
    return "switched";
  } catch (error) {
    if (isPreconditionFailed(error)) return "conflict";
    throw error;
  }
}

/**
 * Crash-safe order: holders, then the pointer, then the record.
 * The pointer decides what a start runs, so it moves first, under its ETag: a
 * start that committed meanwhile makes the write fail. A crash after it leaves
 * the record on the old release as origin only; a repeat of the request ends the
 * job. A crash before it leaves an extra holder, and only retirement removes one.
 */
export async function switchBeforeFirstStart(ports: SwitchPorts, request: SwitchRequest): Promise<SwitchOutcome> {
  const [pointer, world] = await Promise.all([
    ports.pointers.read({ worldId: request.worldId, generationId: request.generationId }),
    ports.worlds.read(request.worldId),
  ]);
  if (pointer === null || world === null || !neverStarted(pointer.state, world.record, request.generationId)) return "conflict";
  const identity: WorldIdentity = { gameId: world.record.gameId, presetId: world.record.preset.id };
  // Holder first (ADR-0080): a refusal stops here, before any pointer or record write.
  await ports.holders.hold(identity, request.worldId, request.generationId, request.release, ["origin", "desired"]);
  const moved = await write(() => ports.pointers.replace({
    ...pointer.state, desiredRelease: request.release, updatedAt: ports.now().toISOString(), updatedBy: request.updatedBy, source: "switch-release",
  }, pointer.etag));
  if (moved === "conflict") return moved;
  const generation = { ...world.record.currentGeneration, release: request.release };
  return write(() => ports.worlds.replace({ ...world.record, currentGeneration: generation }, world.etag));
}
