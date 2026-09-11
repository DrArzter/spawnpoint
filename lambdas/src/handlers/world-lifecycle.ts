import {
  DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand,
  NoSuchKey, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import { backupInventory } from "../control-plane/backups.ts";
import { parsePresetCatalog } from "../control-plane/preset-catalog.ts";
import { type ReleaseState } from "../control-plane/release-state.ts";
import { S3ReleaseStateStore } from "../control-plane/s3-release-state-store.ts";
import { S3WorldRepository } from "../control-plane/s3-world-repository.ts";
import {
  archiveWorldRecord, parseWorldRecord, purgeGenerationIds, regenerateWorldRecord, restoreWorldRecord, type WorldRecord,
} from "../control-plane/world-registry.ts";

type Input = Readonly<{
  action: "archive" | "regenerate" | "restore" | "purge";
  worldId: string;
  generationUuid?: string;
  targetGenerationId?: string;
  backupKey?: string;
  release?: string;
  requestedAt: string;
  requestedBy: string;
}>;

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERATION_ID = /^gen-[0-9a-f]{32}$/;
const s3 = new S3Client({});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

async function jsonObject(bucket: string, key: string): Promise<{ value: Record<string, unknown>; etag: string }> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();
  if (!body || !response.ETag) throw new Error(`invalid object: ${key}`);
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid object: ${key}`);
  return { value: value as Record<string, unknown>, etag: response.ETag };
}

async function optionalJsonObject(bucket: string, key: string): Promise<{ value: Record<string, unknown>; etag: string } | null> {
  try {
    return await jsonObject(bucket, key);
  } catch (error) {
    if (error instanceof NoSuchKey || (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))) return null;
    throw error;
  }
}

function parseInput(value: unknown): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
  const input = value as Record<string, unknown>;
  if (
    (input.action !== "archive" && input.action !== "regenerate" && input.action !== "restore" && input.action !== "purge") ||
    typeof input.worldId !== "string" || !WORLD_ID.test(input.worldId) ||
    typeof input.requestedAt !== "string" || Number.isNaN(Date.parse(input.requestedAt)) ||
    typeof input.requestedBy !== "string" || !input.requestedBy ||
    (input.action !== "archive" && input.action !== "purge" && (typeof input.generationUuid !== "string" || !UUID.test(input.generationUuid))) ||
    (input.action === "purge" && (typeof input.targetGenerationId !== "string" || !GENERATION_ID.test(input.targetGenerationId))) ||
    (input.action === "restore" && typeof input.backupKey !== "string") ||
    (input.action === "regenerate" && (typeof input.release !== "string" || !/^[0-9]+\.[0-9]+$/.test(input.release)))
  ) throw new Error("invalid_input");
  return input as Input;
}

async function versionedObjects(bucket: string, prefix: string, exactKey?: string) {
  const objects: Array<{ Key: string; VersionId: string }> = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
    }));
    for (const object of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (object.Key && object.VersionId && (exactKey === undefined || object.Key === exactKey)) {
        objects.push({ Key: object.Key, VersionId: object.VersionId });
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  return objects;
}

async function permanentlyDelete(bucket: string, prefix: string, exactKey?: string): Promise<void> {
  const objects = await versionedObjects(bucket, prefix, exactKey);
  for (let offset = 0; offset < objects.length; offset += 1000) {
    const page = objects.slice(offset, offset + 1000);
    const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page, Quiet: true } }));
    if ((deleted.Errors ?? []).length > 0) throw new Error("purge_delete_failed");
  }
}

function purgeMarker(value: Record<string, unknown>, worldId: string, targetGenerationId: string) {
  const generations = value.generation_ids;
  if (
    value.schema_version !== 1 || value.world_id !== worldId || value.target_generation_id !== targetGenerationId ||
    (value.status !== "pending" && value.status !== "completed") || !Array.isArray(generations) ||
    generations.length < 1 || generations.some((generation) => typeof generation !== "string" || !GENERATION_ID.test(generation))
  ) throw new Error("invalid_purge_marker");
  return { status: value.status, generations: generations as string[] };
}

async function purgeWorld(input: Input, releaseBucket: string) {
  const targetGenerationId = input.targetGenerationId!;
  const markerKey = `worlds/${input.worldId}/purges/${targetGenerationId}.json`;
  const recordKey = `worlds/${input.worldId}/world.json`;
  let marker = await optionalJsonObject(releaseBucket, markerKey);
  const storedRecord = await optionalJsonObject(releaseBucket, recordKey);
  const currentRecord = storedRecord === null ? null : parseWorldRecord(storedRecord.value);
  if (storedRecord !== null && currentRecord === null) throw new Error("invalid_world_record");
  if (currentRecord !== null && currentRecord.currentGeneration.id !== targetGenerationId) {
    if (marker !== null && purgeMarker(marker.value, input.worldId, targetGenerationId).status === "completed") {
      return { result: "already_applied", worldId: input.worldId, generationId: targetGenerationId };
    }
    throw new Error("operation_id_conflict");
  }
  let generations: readonly string[];
  if (marker === null) {
    if (storedRecord === null) throw new Error("invalid_world_record");
    if (currentRecord!.worldId !== input.worldId) throw new Error("invalid_world_record");
    generations = purgeGenerationIds(currentRecord!);
    const document = {
      schema_version: 1, world_id: input.worldId, target_generation_id: targetGenerationId,
      status: "pending", generation_ids: generations, requested_at: input.requestedAt, requested_by: input.requestedBy,
    };
    await s3.send(new PutObjectCommand({
      Bucket: releaseBucket, Key: markerKey, IfNoneMatch: "*", ContentType: "application/json",
      ServerSideEncryption: "AES256", Body: JSON.stringify(document),
    }));
    marker = await jsonObject(releaseBucket, markerKey);
  } else {
    const parsed = purgeMarker(marker.value, input.worldId, targetGenerationId);
    if (parsed.status === "completed") {
      if (storedRecord !== null) await permanentlyDelete(releaseBucket, recordKey, recordKey);
      return { result: storedRecord === null ? "already_applied" : "purge", worldId: input.worldId, generationId: targetGenerationId };
    }
    generations = parsed.generations;
  }

  const backupBucket = requiredEnv("BACKUP_BUCKET");
  await permanentlyDelete(backupBucket, `worlds/${input.worldId}/archives/`);
  await permanentlyDelete(releaseBucket, `worlds/${input.worldId}/generations/`);
  await permanentlyDelete(releaseBucket, `worlds/${input.worldId}/release.json`, `worlds/${input.worldId}/release.json`);
  await s3.send(new PutObjectCommand({
    Bucket: releaseBucket, Key: markerKey, IfMatch: marker.etag, ContentType: "application/json",
    ServerSideEncryption: "AES256", Body: JSON.stringify({ ...marker.value, status: "completed", purged_at: input.requestedAt }),
  }));
  await permanentlyDelete(releaseBucket, recordKey, recordKey);
  return { result: "purge", worldId: input.worldId, generationId: targetGenerationId, generations };
}

async function verifiedBackups(worldId: string) {
  const listing = await s3.send(new ListObjectsV2Command({
    Bucket: requiredEnv("BACKUP_BUCKET"), Prefix: `worlds/${worldId}/archives/`, MaxKeys: 1000,
  }));
  return backupInventory((listing.Contents ?? []).flatMap((object) => object.Key && object.LastModified ? [{
    key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(),
    checksumAlgorithms: object.ChecksumAlgorithm ?? [],
  }] : []), 1000).entries;
}

async function latestPreset(record: WorldRecord) {
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  const { value } = await jsonObject(releaseBucket, `presets/${record.gameId}/catalog.json`);
  const presets = parsePresetCatalog(value, record.gameId);
  if (presets === null) throw new Error("invalid_preset_catalog");
  const preset = presets.find((candidate) => candidate.id === record.preset.id);
  if (preset === undefined) throw new Error("preset_removed");
  return preset;
}

async function writeInitialReleaseState(record: WorldRecord, input: Input): Promise<void> {
  const store = new S3ReleaseStateStore(s3, requiredEnv("RELEASE_BUCKET"));
  const state: ReleaseState = {
    worldId: record.worldId,
    generationId: record.currentGeneration.id,
    desiredRelease: record.currentGeneration.release,
    activeRelease: null,
    updatedAt: input.requestedAt,
    updatedBy: input.requestedBy,
    source: input.action === "restore" ? "restore-backup" : "start-wipe",
  };
  try {
    await store.create(state);
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "PreconditionFailed" && error.name !== "ConditionalRequestConflict")) throw error;
    const existing = await store.read({ worldId: state.worldId, generationId: state.generationId });
    if (existing === null || existing.state.desiredRelease !== state.desiredRelease) throw new Error("release_state_conflict");
  }
}

export async function handler(event: unknown) {
  const input = parseInput(event);
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  if (input.action === "purge") return purgeWorld(input, releaseBucket);
  const worlds = new S3WorldRepository(s3, releaseBucket);
  const stored = await worlds.read(input.worldId);
  if (stored === null) throw new Error("invalid_world_record");
  const record = stored.record;

  const expectedGenerationId = input.generationUuid ? `gen-${input.generationUuid.replaceAll("-", "")}` : null;
  const releaseStates = new S3ReleaseStateStore(s3, releaseBucket);
  let next: WorldRecord;
  let changed = true;
  if (input.action === "archive" && record.status === "archived") {
    next = record;
    changed = false;
  } else if (input.action !== "archive" && record.currentGeneration.id === expectedGenerationId) {
    if (input.action === "restore" && (record.currentGeneration.source.kind !== "backup" || record.currentGeneration.source.key !== input.backupKey)) {
      throw new Error("operation_id_conflict");
    }
    next = record;
    changed = false;
  } else {
    const backups = await verifiedBackups(record.worldId);
    const currentRelease = await releaseStates.readOrMigrateLegacy({ worldId: record.worldId, generationId: record.currentGeneration.id });
    if (currentRelease !== null && currentRelease.state.activeRelease !== null && !backups.some((backup) => backup.generationId === record.currentGeneration.id)) {
      throw new Error("current_generation_backup_missing");
    }
    if (input.action === "archive") {
      next = archiveWorldRecord(record);
    } else if (input.action === "regenerate") {
      const release = input.release!;
      const preset = await latestPreset(record);
      if (!preset.releases.includes(release)) throw new Error("release_not_available");
      next = regenerateWorldRecord(record, preset, release, input.generationUuid!, input.requestedAt);
    } else {
      const backup = backups.find((candidate) => candidate.key === input.backupKey);
      if (backup === undefined || backup.generationId === null) throw new Error("backup_not_verified");
      next = restoreWorldRecord(record, {
        key: backup.key, checksum: backup.checksum, generationId: backup.generationId,
      }, input.generationUuid!, input.requestedAt);
    }
  }

  if (changed) {
    await worlds.replace(next, stored.etag);
  }
  if (input.action !== "archive") await writeInitialReleaseState(next, input);
  return { result: changed ? input.action : "already_applied", worldId: next.worldId, generationId: next.currentGeneration.id };
}
