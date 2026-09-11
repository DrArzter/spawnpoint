import type { PresetObservation } from "./preset-catalog.ts";

export type GenerationSource =
  | Readonly<{ kind: "preset" }>
  | Readonly<{ kind: "backup"; key: string; checksum: string; generationId: string }>;

export type WorldGeneration = Readonly<{
  id: string;
  release: string;
  createdAt: string;
  source: GenerationSource;
}>;

export type ClosedWorldGeneration = WorldGeneration & Readonly<{ closedAt: string }>;

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
  currentGeneration: WorldGeneration;
  previousGenerations: readonly ClosedWorldGeneration[];
}>;

type ObjectValue = Record<string, unknown>;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GENERATION_ID = /^gen-[0-9a-f]{32}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE = /^[0-9]+\.[0-9]+$/;
const BACKUP_KEY = /^worlds\/[a-z0-9][a-z0-9-]{0,31}\/archives\/[A-Za-z0-9._-]+\.tar\.zst$/;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

export function worldIdForName(gameId: string, displayName: string, worldUuid: string): string {
  if (!ID.test(gameId) || !/^[0-9a-f-]{36}$/.test(worldUuid)) throw new Error("invalid_world_identity");
  const slug = displayName.normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "world";
  const namespace = gameId.slice(0, 12);
  const suffix = worldUuid.replaceAll("-", "").slice(0, 8);
  const available = 32 - namespace.length - suffix.length - 2;
  const boundedSlug = slug.slice(0, Math.max(1, available)).replace(/-$/, "") || "w";
  return `${namespace}-${boundedSlug}-${suffix}`;
}

export function newWorldRecord(
  preset: PresetObservation,
  identity: Readonly<{ worldId: string; displayName: string; release: string }>,
  generationUuid: string,
  createdAt: string,
): WorldRecord {
  if (
    preset.buildStatus !== "ready" || !preset.releases.includes(identity.release) ||
    !ID.test(identity.worldId) || identity.displayName.length < 1 || identity.displayName.length > 80 ||
    !RELEASE.test(identity.release) || Number.isNaN(Date.parse(createdAt))
  ) throw new Error("invalid_world_creation");
  const generationId = `gen-${generationUuid.replaceAll("-", "")}`;
  if (!GENERATION_ID.test(generationId)) throw new Error("invalid_generation_id");
  return {
    worldId: identity.worldId,
    gameId: preset.gameId,
    displayName: identity.displayName,
    status: "active",
    connectivity: "zerotier",
    preset: {
      id: preset.id,
      repository: preset.repository,
      commit: preset.commit,
      profileDigest: preset.profileDigest,
    },
    currentGeneration: { id: generationId, release: identity.release, createdAt, source: { kind: "preset" } },
    previousGenerations: [],
  };
}

function generationId(generationUuid: string): string {
  const value = `gen-${generationUuid.replaceAll("-", "")}`;
  if (!GENERATION_ID.test(value)) throw new Error("invalid_generation_id");
  return value;
}

function closedCurrent(record: WorldRecord, closedAt: string): ClosedWorldGeneration {
  if (Number.isNaN(Date.parse(closedAt))) throw new Error("invalid_closed_at");
  return { ...record.currentGeneration, closedAt };
}

export function archiveWorldRecord(record: WorldRecord): WorldRecord {
  if (record.status === "archived") return record;
  return { ...record, status: "archived" };
}

export function purgeGenerationIds(record: WorldRecord): readonly string[] {
  if (record.status !== "archived") throw new Error("world_not_archived");
  return [record.currentGeneration.id, ...record.previousGenerations.map((generation) => generation.id)];
}

export function regenerateWorldRecord(
  record: WorldRecord,
  preset: PresetObservation,
  release: string,
  generationUuid: string,
  createdAt: string,
): WorldRecord {
  if (record.status !== "active") throw new Error("world_archived");
  if (preset.gameId !== record.gameId || preset.id !== record.preset.id) throw new Error("preset_mismatch");
  if (preset.buildStatus !== "ready" || !preset.releases.includes(release) || !RELEASE.test(release) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("preset_release_not_ready");
  }
  return {
    ...record,
    preset: {
      id: preset.id, repository: preset.repository, commit: preset.commit, profileDigest: preset.profileDigest,
    },
    currentGeneration: { id: generationId(generationUuid), release, createdAt, source: { kind: "preset" } },
    previousGenerations: [...record.previousGenerations, closedCurrent(record, createdAt)],
  };
}

export function restoreWorldRecord(
  record: WorldRecord,
  backup: Readonly<{ key: string; checksum: string; generationId: string }>,
  generationUuid: string,
  createdAt: string,
): WorldRecord {
  if (
    !BACKUP_KEY.test(backup.key) || !backup.key.startsWith(`worlds/${record.worldId}/archives/`) ||
    !backup.key.endsWith(`-${backup.checksum}.tar.zst`) || !backup.key.includes(`-${backup.generationId}-`) ||
    !SHA256.test(backup.checksum) || !GENERATION_ID.test(backup.generationId)
  ) {
    throw new Error("invalid_backup");
  }
  const source = [record.currentGeneration, ...record.previousGenerations]
    .find((generation) => generation.id === backup.generationId);
  if (source === undefined) throw new Error("backup_generation_unknown");
  return {
    ...record,
    status: "active",
    currentGeneration: {
      id: generationId(generationUuid), release: source.release, createdAt,
      source: { kind: "backup", key: backup.key, checksum: backup.checksum, generationId: backup.generationId },
    },
    previousGenerations: [...record.previousGenerations, closedCurrent(record, createdAt)],
  };
}

function generationSource(value: unknown): GenerationSource | null {
  const source = object(value);
  if (source === null || source.kind === "preset") return { kind: "preset" };
  if (
    source.kind !== "backup" || typeof source.key !== "string" || !BACKUP_KEY.test(source.key) ||
    typeof source.checksum !== "string" || !SHA256.test(source.checksum) ||
    typeof source.generation_id !== "string" || !GENERATION_ID.test(source.generation_id)
  ) return null;
  return { kind: "backup", key: source.key, checksum: source.checksum, generationId: source.generation_id };
}

function parseGeneration(value: unknown, closed: boolean): WorldGeneration | ClosedWorldGeneration | null {
  const generation = object(value);
  const source = generationSource(generation?.source);
  if (
    generation === null || typeof generation.id !== "string" || !GENERATION_ID.test(generation.id) ||
    typeof generation.release !== "string" || !RELEASE.test(generation.release) ||
    typeof generation.created_at !== "string" || Number.isNaN(Date.parse(generation.created_at)) || source === null
  ) return null;
  const parsed = { id: generation.id, release: generation.release, createdAt: generation.created_at, source };
  if (!closed) return parsed;
  if (typeof generation.closed_at !== "string" || Number.isNaN(Date.parse(generation.closed_at))) return null;
  return { ...parsed, closedAt: generation.closed_at };
}

function generationDocument(generation: WorldGeneration | ClosedWorldGeneration): ObjectValue {
  return {
    id: generation.id,
    release: generation.release,
    created_at: generation.createdAt,
    ...(generation.source.kind === "preset" ? { source: { kind: "preset" } } : { source: {
      kind: "backup", key: generation.source.key, checksum: generation.source.checksum,
      generation_id: generation.source.generationId,
    } }),
    ...("closedAt" in generation ? { closed_at: generation.closedAt } : {}),
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
    current_generation: generationDocument(record.currentGeneration),
    previous_generations: record.previousGenerations.map(generationDocument),
  };
}

export function parseWorldRecord(value: unknown): WorldRecord | null {
  const root = object(value);
  const preset = object(root?.preset);
  const generation = parseGeneration(root?.current_generation, false);
  const previousValues = root?.previous_generations ?? [];
  const previous = Array.isArray(previousValues) ? previousValues.map((value) => parseGeneration(value, true)) : null;
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
    generation === null || previous === null || previous.some((value) => value === null)
  ) return null;
  const current = generation as WorldGeneration;
  const history = previous as ClosedWorldGeneration[];
  const ids = [current.id, ...history.map((item) => item.id)];
  const backupSource = current.source.kind === "backup" ? current.source : null;
  if (
    new Set(ids).size !== ids.length ||
    history.some((item) => Date.parse(item.closedAt) < Date.parse(item.createdAt)) ||
    (backupSource !== null && (
      !backupSource.key.startsWith(`worlds/${root.world_id}/archives/`) ||
      !backupSource.key.endsWith(`-${backupSource.checksum}.tar.zst`) ||
      !backupSource.key.includes(`-${backupSource.generationId}-`) ||
      !history.some((item) => item.id === backupSource.generationId)
    ))
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
    currentGeneration: current,
    previousGenerations: history,
  };
}
