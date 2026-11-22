export type WorldRef = Readonly<{ worldId: string; generationId: string }>;

/** A release this wipe ran, from the first start that committed it (ADR-0052). */
export type ReleaseRun = Readonly<{ release: string; since: string }>;

/** The archive a promotion kept before it changed the release (ADR-0030). Retention keeps it until the next promotion. */
export type PrePromotionBackup = Readonly<{
  key: string;
  operationId: string;
  release: string | null;
  recordedAt: string;
}>;

export type ReleaseState = Readonly<{
  worldId: string;
  generationId: string;
  desiredRelease: string;
  activeRelease: string | null;
  updatedAt: string;
  updatedBy: string;
  source: string;
  /** Absent on a pointer written before the wipe's runs were recorded. */
  releasesRun?: readonly ReleaseRun[];
  prePromotionBackup?: PrePromotionBackup;
}>;

type ObjectValue = Record<string, unknown>;
const WORLD_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GENERATION_ID = /^gen-[0-9a-f]{32}$/;
const RELEASE = /^\d+\.\d+$/;
const ARCHIVE_KEY = /^worlds\/[a-z0-9][a-z0-9-]{0,31}\/archives\/[A-Za-z0-9._-]+\.tar\.zst$/;

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

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseRuns(value: unknown): ReleaseRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: ReleaseRun[] = [];
  for (const item of value) {
    const run = object(item);
    if (run === null || typeof run.release !== "string" || !RELEASE.test(run.release) || !validDate(run.since)) return null;
    runs.push({ release: run.release, since: run.since });
  }
  return runs;
}

function archiveOf(key: string, worldId: string, generationId: string): boolean {
  return ARCHIVE_KEY.test(key) && key.startsWith(`worlds/${worldId}/archives/${worldId}-${generationId}-`);
}

function parsePrePromotionBackup(value: unknown, worldId: string, generationId: string): PrePromotionBackup | null {
  const backup = object(value);
  if (
    backup === null || typeof backup.key !== "string" || !archiveOf(backup.key, worldId, generationId) ||
    typeof backup.operation_id !== "string" || backup.operation_id.length < 1 ||
    (backup.release !== null && (typeof backup.release !== "string" || !RELEASE.test(backup.release))) ||
    !validDate(backup.recorded_at)
  ) return null;
  return { key: backup.key, operationId: backup.operation_id, release: backup.release, recordedAt: backup.recorded_at };
}

export function parseReleaseState(value: unknown, expected?: WorldRef): ReleaseState | null {
  const root = object(value);
  if (
    root?.schema_version !== 2 || typeof root.world_id !== "string" || !WORLD_ID.test(root.world_id) ||
    typeof root.generation_id !== "string" || !GENERATION_ID.test(root.generation_id) ||
    typeof root.desired_release !== "string" || !RELEASE.test(root.desired_release) ||
    (root.active_release !== null && (typeof root.active_release !== "string" || !RELEASE.test(root.active_release))) ||
    typeof root.updated_at !== "string" || Number.isNaN(Date.parse(root.updated_at)) ||
    typeof root.updated_by !== "string" || root.updated_by.length < 1 ||
    typeof root.source !== "string" || root.source.length < 1
  ) return null;
  if (expected && (root.world_id !== expected.worldId || root.generation_id !== expected.generationId)) return null;
  const runs = root.releases_run === undefined ? undefined : parseRuns(root.releases_run);
  const backup = root.pre_promotion_backup === undefined ? undefined
    : parsePrePromotionBackup(root.pre_promotion_backup, root.world_id, root.generation_id);
  if (runs === null || backup === null) return null;
  return {
    worldId: root.world_id,
    generationId: root.generation_id,
    desiredRelease: root.desired_release,
    activeRelease: root.active_release,
    updatedAt: root.updated_at,
    updatedBy: root.updated_by,
    source: root.source,
    ...(runs === undefined ? {} : { releasesRun: runs }),
    ...(backup === undefined ? {} : { prePromotionBackup: backup }),
  };
}

export function releaseStateDocument(state: ReleaseState): ObjectValue {
  assertWorldRef(state);
  if (
    !RELEASE.test(state.desiredRelease) ||
    (state.activeRelease !== null && !RELEASE.test(state.activeRelease)) ||
    Number.isNaN(Date.parse(state.updatedAt)) || !state.updatedBy || !state.source ||
    (state.releasesRun ?? []).some((run) => !RELEASE.test(run.release) || !validDate(run.since)) ||
    (state.prePromotionBackup !== undefined && (
      !archiveOf(state.prePromotionBackup.key, state.worldId, state.generationId) || !state.prePromotionBackup.operationId ||
      (state.prePromotionBackup.release !== null && !RELEASE.test(state.prePromotionBackup.release)) ||
      !validDate(state.prePromotionBackup.recordedAt)))
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
    ...(state.releasesRun === undefined ? {} : {
      releases_run: state.releasesRun.map((run) => ({ release: run.release, since: run.since })),
    }),
    ...(state.prePromotionBackup === undefined ? {} : { pre_promotion_backup: {
      key: state.prePromotionBackup.key,
      operation_id: state.prePromotionBackup.operationId,
      release: state.prePromotionBackup.release,
      recorded_at: state.prePromotionBackup.recordedAt,
    } }),
  };
}

/** The release this wipe ran at a moment: the newest run that began by then, else the oldest one recorded. */
export function releaseRunAt(runs: readonly ReleaseRun[], at: string): string | null {
  const moment = Date.parse(at);
  let found: ReleaseRun | null = null;
  for (const run of runs) {
    if (Date.parse(run.since) <= moment && (found === null || Date.parse(run.since) >= Date.parse(found.since))) found = run;
  }
  return found?.release ?? runs[0]?.release ?? null;
}

export function parseLegacyReleaseState(value: unknown, ref: WorldRef, migratedAt: string): ReleaseState | null {
  const root = object(value);
  if (
    root?.schema_version !== 1 || root.world !== ref.worldId ||
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
