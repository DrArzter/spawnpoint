export type WorldRef = Readonly<{ worldId: string; generationId: string }>;

export type ReleaseState = Readonly<{
  worldId: string;
  generationId: string;
  desiredRelease: string;
  activeRelease: string | null;
  updatedAt: string;
  updatedBy: string;
  source: string;
}>;

type ObjectValue = Record<string, unknown>;
const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GENERATION_ID = /^gen-[0-9a-f]{32}$/;
const RELEASE = /^[0-9]+\.[0-9]+$/;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

export function assertWorldRef(ref: WorldRef): void {
  if (!WORLD_ID.test(ref.worldId) || !GENERATION_ID.test(ref.generationId)) throw new Error("invalid_world_ref");
}

export function releaseStateKey(ref: WorldRef): string {
  assertWorldRef(ref);
  return `worlds/${ref.worldId}/generations/${ref.generationId}/release.json`;
}

export function legacyReleaseStateKey(worldId: string): string {
  if (!WORLD_ID.test(worldId)) throw new Error("invalid_world_ref");
  return `worlds/${worldId}/release.json`;
}

export function parseReleaseState(value: unknown, expected?: WorldRef): ReleaseState | null {
  const root = object(value);
  if (
    root === null || root.schema_version !== 2 || typeof root.world_id !== "string" || !WORLD_ID.test(root.world_id) ||
    typeof root.generation_id !== "string" || !GENERATION_ID.test(root.generation_id) ||
    typeof root.desired_release !== "string" || !RELEASE.test(root.desired_release) ||
    (root.active_release !== null && (typeof root.active_release !== "string" || !RELEASE.test(root.active_release))) ||
    typeof root.updated_at !== "string" || Number.isNaN(Date.parse(root.updated_at)) ||
    typeof root.updated_by !== "string" || root.updated_by.length < 1 ||
    typeof root.source !== "string" || root.source.length < 1
  ) return null;
  if (expected && (root.world_id !== expected.worldId || root.generation_id !== expected.generationId)) return null;
  return {
    worldId: root.world_id,
    generationId: root.generation_id,
    desiredRelease: root.desired_release,
    activeRelease: root.active_release,
    updatedAt: root.updated_at,
    updatedBy: root.updated_by,
    source: root.source,
  };
}

export function releaseStateDocument(state: ReleaseState): ObjectValue {
  assertWorldRef(state);
  if (
    !RELEASE.test(state.desiredRelease) ||
    (state.activeRelease !== null && !RELEASE.test(state.activeRelease)) ||
    Number.isNaN(Date.parse(state.updatedAt)) || !state.updatedBy || !state.source
  ) throw new Error("invalid_release_state");
  return {
    schema_version: 2,
    world_id: state.worldId,
    generation_id: state.generationId,
    desired_release: state.desiredRelease,
    active_release: state.activeRelease,
    updated_at: state.updatedAt,
    updated_by: state.updatedBy,
    source: state.source,
  };
}

export function parseLegacyReleaseState(value: unknown, ref: WorldRef, migratedAt: string): ReleaseState | null {
  const root = object(value);
  if (
    root === null || root.schema_version !== 1 || root.world !== ref.worldId ||
    typeof root.desired_release !== "string" || !RELEASE.test(root.desired_release) ||
    (root.active_release !== null && (typeof root.active_release !== "string" || !RELEASE.test(root.active_release))) ||
    Number.isNaN(Date.parse(migratedAt))
  ) return null;
  return {
    worldId: ref.worldId,
    generationId: ref.generationId,
    desiredRelease: root.desired_release,
    activeRelease: root.active_release,
    updatedAt: migratedAt,
    updatedBy: "legacy-pointer-migration",
    source: "migration",
  };
}
