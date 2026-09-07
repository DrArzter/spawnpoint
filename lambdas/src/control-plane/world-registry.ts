import type { PresetObservation } from "./preset-catalog.ts";

export type WorldRecord = Readonly<{
  worldId: string;
  gameId: string;
  displayName: string;
  status: "active" | "archived";
  connectivity: "zerotier";
  preset: Readonly<{
    id: string;
    repository: string;
    commit: string;
    profileDigest: string;
  }>;
  currentGeneration: Readonly<{
    id: string;
    release: string;
    createdAt: string;
  }>;
}>;

type ObjectValue = Record<string, unknown>;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GENERATION_ID = /^gen-[0-9a-f]{32}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE = /^[0-9]+\.[0-9]+$/;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

export function worldIdForPreset(preset: PresetObservation): string {
  const natural = preset.id.startsWith(`${preset.gameId}-`) ? preset.id : `${preset.gameId}-${preset.id}`;
  if (natural.length <= 32) return natural;
  return `${preset.gameId.slice(0, 7)}-${preset.id.slice(0, 15)}-${preset.profileDigest.slice(0, 8)}`;
}

export function newWorldRecord(
  preset: PresetObservation,
  generationUuid: string,
  createdAt: string,
): WorldRecord {
  if (preset.buildStatus !== "ready" || preset.latestRelease === null) throw new Error("preset_release_not_ready");
  const generationId = `gen-${generationUuid.replaceAll("-", "")}`;
  if (!GENERATION_ID.test(generationId)) throw new Error("invalid_generation_id");
  return {
    worldId: worldIdForPreset(preset),
    gameId: preset.gameId,
    displayName: preset.displayName,
    status: "active",
    connectivity: "zerotier",
    preset: {
      id: preset.id,
      repository: preset.repository,
      commit: preset.commit,
      profileDigest: preset.profileDigest,
    },
    currentGeneration: { id: generationId, release: preset.latestRelease, createdAt },
  };
}

export function worldRecordDocument(record: WorldRecord): ObjectValue {
  return {
    schema_version: 1,
    world_id: record.worldId,
    game: record.gameId,
    display_name: record.displayName,
    status: record.status,
    connectivity: record.connectivity,
    storage_layout: "generation",
    preset: {
      id: record.preset.id,
      repository: record.preset.repository,
      commit: record.preset.commit,
      profile_digest: record.preset.profileDigest,
    },
    current_generation: {
      id: record.currentGeneration.id,
      release: record.currentGeneration.release,
      created_at: record.currentGeneration.createdAt,
    },
  };
}

export function parseWorldRecord(value: unknown): WorldRecord | null {
  const root = object(value);
  const preset = object(root?.preset);
  const generation = object(root?.current_generation);
  if (
    root === null || root.schema_version !== 1 || root.storage_layout !== "generation" ||
    typeof root.world_id !== "string" || !ID.test(root.world_id) ||
    typeof root.game !== "string" || !ID.test(root.game) ||
    typeof root.display_name !== "string" || root.display_name.length < 1 || root.display_name.length > 80 ||
    (root.status !== "active" && root.status !== "archived") || root.connectivity !== "zerotier" ||
    preset === null || typeof preset.id !== "string" || !ID.test(preset.id) ||
    typeof preset.repository !== "string" || !preset.repository.startsWith("https://github.com/") ||
    typeof preset.commit !== "string" || !COMMIT.test(preset.commit) ||
    typeof preset.profile_digest !== "string" || !SHA256.test(preset.profile_digest) ||
    generation === null || typeof generation.id !== "string" || !GENERATION_ID.test(generation.id) ||
    typeof generation.release !== "string" || !RELEASE.test(generation.release) ||
    typeof generation.created_at !== "string" || Number.isNaN(Date.parse(generation.created_at))
  ) return null;
  return {
    worldId: root.world_id,
    gameId: root.game,
    displayName: root.display_name,
    status: root.status,
    connectivity: root.connectivity,
    preset: {
      id: preset.id,
      repository: preset.repository,
      commit: preset.commit,
      profileDigest: preset.profile_digest,
    },
    currentGeneration: {
      id: generation.id,
      release: generation.release,
      createdAt: generation.created_at,
    },
  };
}
