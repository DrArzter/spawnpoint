import {
  GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

import { backupInventory } from "../control-plane/backups.ts";
import { parsePresetCatalog } from "../control-plane/preset-catalog.ts";
import {
  archiveWorldRecord, parseWorldRecord, regenerateWorldRecord, restoreWorldRecord,
  worldRecordDocument, type WorldRecord,
} from "../control-plane/world-registry.ts";

type Input = Readonly<{
  action: "archive" | "regenerate" | "restore";
  worldId: string;
  generationUuid?: string;
  backupKey?: string;
  requestedAt: string;
  requestedBy: string;
}>;

const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

function parseInput(value: unknown): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
  const input = value as Record<string, unknown>;
  if (
    (input.action !== "archive" && input.action !== "regenerate" && input.action !== "restore") ||
    typeof input.worldId !== "string" || !WORLD_ID.test(input.worldId) ||
    typeof input.requestedAt !== "string" || Number.isNaN(Date.parse(input.requestedAt)) ||
    typeof input.requestedBy !== "string" || !input.requestedBy ||
    (input.action !== "archive" && (typeof input.generationUuid !== "string" || !UUID.test(input.generationUuid))) ||
    (input.action === "restore" && typeof input.backupKey !== "string")
  ) throw new Error("invalid_input");
  return input as Input;
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

async function activeRelease(worldId: string): Promise<string | null> {
  const { value } = await jsonObject(requiredEnv("RELEASE_BUCKET"), `worlds/${worldId}/release.json`);
  const active = value.active_release;
  if (active !== null && (typeof active !== "string" || !/^[0-9]+\.[0-9]+$/.test(active))) {
    throw new Error("invalid_release_pointer");
  }
  return active as string | null;
}

async function writePointer(record: WorldRecord, input: Input): Promise<void> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const key = `worlds/${record.worldId}/release.json`;
  const current = await jsonObject(bucket, key);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, IfMatch: current.etag, ContentType: "application/json", ServerSideEncryption: "AES256",
    Body: JSON.stringify({
      ...current.value,
      schema_version: 1,
      world: record.worldId,
      desired_release: record.currentGeneration.release,
      updated_at: input.requestedAt,
      updated_by: input.requestedBy,
    }),
  }));
}

export async function handler(event: unknown) {
  const input = parseInput(event);
  const releaseBucket = requiredEnv("RELEASE_BUCKET");
  const recordKey = `worlds/${input.worldId}/world.json`;
  const stored = await jsonObject(releaseBucket, recordKey);
  const record = parseWorldRecord(stored.value);
  if (record === null || record.worldId !== input.worldId) throw new Error("invalid_world_record");

  const expectedGenerationId = input.generationUuid ? `gen-${input.generationUuid.replaceAll("-", "")}` : null;
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
    if (await activeRelease(record.worldId) !== null && !backups.some((backup) => backup.generationId === record.currentGeneration.id)) {
      throw new Error("current_generation_backup_missing");
    }
    if (input.action === "archive") {
      next = archiveWorldRecord(record);
    } else if (input.action === "regenerate") {
      next = regenerateWorldRecord(record, await latestPreset(record), input.generationUuid!, input.requestedAt);
    } else {
      const backup = backups.find((candidate) => candidate.key === input.backupKey);
      if (backup === undefined || backup.generationId === null) throw new Error("backup_not_verified");
      next = restoreWorldRecord(record, {
        key: backup.key, checksum: backup.checksum, generationId: backup.generationId,
      }, input.generationUuid!, input.requestedAt);
    }
  }

  if (changed) {
    await s3.send(new PutObjectCommand({
      Bucket: releaseBucket, Key: recordKey, IfMatch: stored.etag,
      ContentType: "application/json", ServerSideEncryption: "AES256",
      Body: JSON.stringify(worldRecordDocument(next)),
    }));
  }
  if (input.action !== "archive") await writePointer(next, input);
  return { result: changed ? input.action : "already_applied", worldId: next.worldId, generationId: next.currentGeneration.id };
}
