import { type FileItemState, type ReleaseItemState, type ReleaseLayout } from "./release-objects.ts";

// The writer's side of the reference table (ADR-0080, design 4.8). Every step
// adds a reference before the file or the record is needed, and removes none:
// a crash keeps a file too long and never loses one. Removal belongs to
// retirement and the reconciler, which are later work.

export type ReleaseRef = Readonly<{ gameId: string; presetId: string; release: string }>;

export type ReleaseItem = Readonly<{ layout: ReleaseLayout; state: ReleaseItemState; holders: number }>;
export type FileItem = Readonly<{ state: FileItemState; refs: number; bytes: number }>;

export type HolderRole = "origin" | "desired" | "active" | "run" | "pre-promotion" | "catalog" | "backup";

/** The holder's sort key is `hold#` plus one of these. */
export const holderKey = {
  generation: (worldId: string, generationId: string) => `gen#${worldId}/${generationId}`,
  catalog: (gameId: string) => `catalog#${gameId}`,
  build: (buildId: string) => `build#${buildId}`,
  backup: (key: string, versionId: string) => `backup#${key}#${versionId}`,
} as const;

export class ReleaseRefsError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ReleaseRefsError";
  }
}

export type FileClaim = Readonly<{ sha256: string; bytes: number; path: string }>;

/** What the writer does with the bytes of one claimed file. */
export type ObjectMode = "create" | "verify" | "recreate";

export type ClaimOptions = Readonly<{
  /** Called for one file after its reference is counted, or, for a deleted file, before it is revived. */
  ensureObject: (file: FileClaim, mode: ObjectMode) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  /** How long a build waits for a delete in progress to end. */
  waitMilliseconds?: number;
}>;
