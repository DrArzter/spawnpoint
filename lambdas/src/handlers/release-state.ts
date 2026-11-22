import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { backupInventory, resumeArchiveKey, type BackupObject } from "../control-plane/backups.ts";
import { releaseStateDocument, type ReleaseState, type WorldRef } from "../control-plane/release-state.ts";
import {
  commitPromotion, preparePromotion, recordPrePromotionBackup, restorePromotion, rollbackPromotion,
} from "../control-plane/release-state-transitions.ts";
import { S3ReleaseStateStore } from "../control-plane/s3-release-state-store.ts";

type Action = "read" | "prepare" | "commit" | "restore" | "rollback" | "protect";
type Input = Readonly<{
  action: Action;
  worldId: string;
  generationId: string;
  release?: string;
  operationId: string;
  previous?: ReleaseState;
}>;

const s3 = new S3Client({});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}

function input(value: unknown): Input {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
  const item = value as Record<string, unknown>;
  if (
    !["read", "prepare", "commit", "restore", "rollback", "protect"].includes(String(item.action)) ||
    typeof item.worldId !== "string" || typeof item.generationId !== "string" ||
    typeof item.operationId !== "string" || item.operationId.length < 1 ||
    ((item.action === "prepare" || item.action === "commit") && typeof item.release !== "string")
  ) throw new Error("invalid_input");
  return item as Input;
}

function previousState(value: unknown, ref: WorldRef): ReleaseState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_previous_state");
  const state = value as unknown as ReleaseState;
  try {
    releaseStateDocument(state);
  } catch {
    throw new Error("invalid_previous_state");
  }
  if (state.worldId !== ref.worldId || state.generationId !== ref.generationId) throw new Error("invalid_previous_state");
  return state;
}

async function listWipeArchives(ref: WorldRef): Promise<BackupObject[]> {
  const objects: BackupObject[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ // NOSONAR paginated: the next token comes from the previous page
      Bucket: requiredEnv("BACKUP_BUCKET"),
      Prefix: `worlds/${ref.worldId}/archives/${ref.worldId}-${ref.generationId}-`,
      ...(token ? { ContinuationToken: token } : {}),
    }));
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified) {
        objects.push({
          key: object.Key, sizeBytes: object.Size ?? 0, storedAt: object.LastModified.toISOString(),
          checksumAlgorithms: object.ChecksumAlgorithm ?? [],
        });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/**
 * The archive the promotion keeps (ADR-0030): the verified archive the wipe
 * would resume from, which is the save the promotion is about to change. Its
 * stop has just verified it, or the world was already stopped on it.
 */
export function prePromotionArchive(ref: WorldRef, objects: readonly BackupObject[]): string | undefined {
  const verified = backupInventory(objects, Number.POSITIVE_INFINITY).entries.map((entry) => entry.key);
  return resumeArchiveKey(ref.worldId, ref.generationId, verified);
}

async function protect(request: Input, stored: Readonly<{ state: ReleaseState; etag: string }>, ref: WorldRef, store: S3ReleaseStateStore) {
  const key = prePromotionArchive(ref, await listWipeArchives(ref));
  if (key === undefined) {
    // A wipe that never ran has no save to lose; one that ran must keep one.
    if (stored.state.activeRelease !== null) throw new Error("pre_promotion_backup_missing");
    return { status: "nothing_to_protect", state: stored.state, key: null };
  }
  const next = recordPrePromotionBackup(stored.state, key, new Date().toISOString(), request.operationId);
  await store.replace(next, stored.etag);
  return { status: "protected", state: next, key };
}

function transition(request: Input, current: ReleaseState, ref: WorldRef, at: string): ReleaseState {
  switch (request.action) {
    case "prepare": return preparePromotion(current, request.release!, at, request.operationId);
    case "commit": return commitPromotion(current, request.release!, at, request.operationId);
    case "restore": return restorePromotion(current, previousState(request.previous, ref), at, request.operationId);
    default: return rollbackPromotion(current, at, request.operationId);
  }
}

export async function handler(event: unknown) {
  const request = input(event);
  const ref = { worldId: request.worldId, generationId: request.generationId };
  const store = new S3ReleaseStateStore(s3, requiredEnv("RELEASE_BUCKET"));
  const stored = await store.readOrMigrateLegacy(ref);
  if (stored === null) throw new Error("world_release_state_missing");
  if (request.action === "read") return { status: "read", state: stored.state };
  if (request.action === "protect") return protect(request, stored, ref, store);
  if (request.action === "prepare" && stored.state.activeRelease === request.release) {
    return { status: "already_active", state: stored.state, previous: stored.state };
  }

  const at = new Date().toISOString();
  const next = transition(request, stored.state, ref, at);
  await store.replace(next, stored.etag);
  return {
    status: request.action === "prepare" ? "prepared" : request.action,
    state: next,
    ...(request.action === "prepare" ? { previous: stored.state } : {}),
  };
}
