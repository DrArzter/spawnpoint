import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { type PresetObservation } from "./preset-catalog.ts";
import { ReleaseHolders, resolveFromWorldRecords } from "./release-holders.ts";
import { ReleaseRefs } from "./release-refs.ts";
import { type ReleaseState } from "./release-state.ts";
import { switchBeforeFirstStart } from "./release-switch.ts";
import { S3ReleaseStateStore } from "./s3-release-state-store.ts";
import { S3WorldReader, S3WorldRepository } from "./s3-world-repository.ts";
import { newWorldRecord, withGameSettings, withWhitelist, withWorldAccess, type WorldGameSettings, type WorldRecord, type WorldWhitelist } from "./world-registry.ts";
import type { WorldRecords } from "./world-records.ts";
import type { SwitchOutcome, SwitchRequest } from "./release-switch.ts";

// A world's record and its release pointer in the release bucket, with the
// holders the release table keeps for each generation (ADR-0080).

const s3 = new S3Client({});
const document = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

// Holder first (ADR-0080): the stores below add a generation's holder before each write.
export function releaseHolders(bucket: string): ReleaseHolders {
  return new ReleaseHolders(new ReleaseRefs(document), resolveFromWorldRecords(new S3WorldReader(s3, bucket)));
}

function worldRepository(): S3WorldRepository {
  const bucket = requiredEnv("RELEASE_BUCKET");
  return new S3WorldRepository(s3, bucket, releaseHolders(bucket));
}

function preconditionFailed(error: unknown): boolean {
  return error instanceof Error && (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

/** Moves a never-started wipe to another release (ADR-0078). Holders, pointer, record: see `switchBeforeFirstStart`. */
async function switchReleaseBeforeFirstStart(request: SwitchRequest): Promise<SwitchOutcome> {
  const bucket = requiredEnv("RELEASE_BUCKET");
  const holders = releaseHolders(bucket);
  return switchBeforeFirstStart({
    holders,
    pointers: new S3ReleaseStateStore(s3, bucket, holders),
    worlds: new S3WorldRepository(s3, bucket, holders),
    now: () => new Date(),
  }, request);
}

async function materializePresetWorld(
  preset: PresetObservation,
  identity: Readonly<{ worldId: string; displayName: string; release: string }>,
  generationUuid: string,
  createdAt: string,
  access?: Readonly<{ placement?: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"] }>,
): Promise<WorldRecord> {
  const proposed = newWorldRecord(preset, identity, generationUuid, createdAt, access);
  const releaseState: ReleaseState = {
    worldId: proposed.worldId,
    generationId: proposed.currentGeneration.id,
    desiredRelease: proposed.currentGeneration.release,
    activeRelease: null,
    updatedAt: createdAt,
    updatedBy: "world-creation",
    source: "create-world",
  };
  const bucket = requiredEnv("RELEASE_BUCKET");
  const holders = releaseHolders(bucket);
  const releaseStates = new S3ReleaseStateStore(s3, bucket, holders);
  const worlds = new S3WorldRepository(s3, bucket, holders);
  try {
    // The world record is not stored yet, so the pointer's holder takes the game and preset from the proposal.
    await releaseStates.create(releaseState, { gameId: proposed.gameId, presetId: proposed.preset.id });
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = await releaseStates.read({ worldId: proposed.worldId, generationId: proposed.currentGeneration.id });
    if (existing?.state.desiredRelease !== proposed.currentGeneration.release) {
      throw new Error("world_release_pointer_conflict");
    }
  }

  try {
    await worlds.create(proposed);
    return proposed;
  } catch (error) {
    if (!preconditionFailed(error)) throw error;
    const existing = (await worlds.read(proposed.worldId))?.record ?? null;
    if (
      existing?.worldId !== proposed.worldId || existing.gameId !== proposed.gameId ||
      existing.displayName !== proposed.displayName || existing.preset.id !== proposed.preset.id ||
      existing.preset.profileDigest !== proposed.preset.profileDigest ||
      existing.currentGeneration.release !== proposed.currentGeneration.release
    ) throw new Error("world_record_conflict");
    return existing;
  }
}

async function readWorldRecord(worldId: string): Promise<WorldRecord | null> {
  return (await new S3WorldReader(s3, requiredEnv("RELEASE_BUCKET")).read(worldId))?.record ?? null;
}

/** A world's game settings (ADR-0064); a running world takes them at its next start. */
async function replaceWorldGameSettings(
  gameId: string,
  worldId: string,
  gameSettings: WorldGameSettings,
): Promise<"updated" | "missing" | "archived" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "archived";
  try {
    await worlds.replace(withGameSettings(stored.record, gameSettings), stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

/** A world's whitelist (ADR-0066). The world keeps it from now on, on every host it lands. */
async function replaceWorldWhitelist(
  gameId: string,
  worldId: string,
  whitelist: WorldWhitelist,
): Promise<"updated" | "missing" | "archived" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "archived";
  try {
    await worlds.replace(withWhitelist(stored.record, whitelist), stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

async function replaceWorldAccess(
  gameId: string,
  worldId: string,
  access: Readonly<{ placement: WorldRecord["placement"]; connectivity: WorldRecord["connectivity"]; auth?: WorldRecord["auth"]; warm?: boolean }>,
): Promise<"updated" | "missing" | "conflict"> {
  const worlds = worldRepository();
  const stored = await worlds.read(worldId);
  if (stored?.record.gameId !== gameId) return "missing";
  if (stored.record.status !== "active") return "conflict";
  const next = withWorldAccess(stored.record, access);
  if (next.placement === stored.record.placement && next.connectivity === stored.record.connectivity && next.auth === stored.record.auth && next.warm === stored.record.warm) return "updated";
  try {
    await worlds.replace(next, stored.etag);
    return "updated";
  } catch (error) {
    if (preconditionFailed(error)) return "conflict";
    throw error;
  }
}

export const awsWorldRecords: WorldRecords = {
  read: readWorldRecord,
  materialize: materializePresetWorld,
  replaceGameSettings: replaceWorldGameSettings,
  replaceWhitelist: replaceWorldWhitelist,
  replaceAccess: replaceWorldAccess,
  switchReleaseBeforeFirstStart,
};
