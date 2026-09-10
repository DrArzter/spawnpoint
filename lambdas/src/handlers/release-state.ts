import { S3Client } from "@aws-sdk/client-s3";

import { releaseStateDocument, type ReleaseState, type WorldRef } from "../control-plane/release-state.ts";
import {
  commitPromotion, preparePromotion, restorePromotion, rollbackPromotion,
} from "../control-plane/release-state-transitions.ts";
import { S3ReleaseStateStore } from "../control-plane/s3-release-state-store.ts";

type Action = "read" | "prepare" | "commit" | "restore" | "rollback";
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
    !["read", "prepare", "commit", "restore", "rollback"].includes(String(item.action)) ||
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

export async function handler(event: unknown) {
  const request = input(event);
  const ref = { worldId: request.worldId, generationId: request.generationId };
  const store = new S3ReleaseStateStore(s3, requiredEnv("RELEASE_BUCKET"));
  const stored = await store.readOrMigrateLegacy(ref);
  if (stored === null) throw new Error("world_release_state_missing");
  if (request.action === "read") return { status: "read", state: stored.state };
  if (request.action === "prepare" && stored.state.activeRelease === request.release) {
    return { status: "already_active", state: stored.state, previous: stored.state };
  }

  const at = new Date().toISOString();
  const next = request.action === "prepare"
    ? preparePromotion(stored.state, request.release!, at, request.operationId)
    : request.action === "commit"
      ? commitPromotion(stored.state, request.release!, at, request.operationId)
      : request.action === "restore"
        ? restorePromotion(stored.state, previousState(request.previous, ref), at, request.operationId)
        : rollbackPromotion(stored.state, at, request.operationId);
  await store.replace(next, stored.etag);
  return {
    status: request.action === "prepare" ? "prepared" : request.action,
    state: next,
    ...(request.action === "prepare" ? { previous: stored.state } : {}),
  };
}
