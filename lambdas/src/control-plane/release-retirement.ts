import { parsePresetCatalog } from "./preset-catalog.ts";
import { isSha256, manifestUsesObjects, type ReleaseItemState, type ReleaseLayout } from "./release-objects.ts";
import { mark, namedDigests, type MarkInput } from "./release-reconciler.ts";
import type { ReleaseRef } from "./release-refs.ts";

// Retirement of one release (ADR-0080, design 4.8), the only way back-references
// go away. Only the owner asks, with a typed confirmation. Every step is
// conditional, so a crash resumes and a repeat changes nothing. The core is pure:
// the ports read and write, this decides. No port touches an S3 object, so the
// bytes stay until the sweep, which has its own proofs.

/** The words a person types: `<game>/<preset>@<release>`. */
export function retirementConfirmation(ref: ReleaseRef): string {
  return `${ref.gameId}/${ref.presetId}@${ref.release}`;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELEASE = /^\d+\.\d+$/;

export type RetirementRequest = Readonly<ReleaseRef & { confirmation: string; requestedBy: string }>;

/** Refuses anything that is not exactly the documented input, whoever sent it. */
export function parseRetirementRequest(value: unknown): RetirementRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const { gameId, presetId, release, confirmation, requestedBy } = input;
  if (typeof gameId !== "string" || !ID.test(gameId) || typeof presetId !== "string" || !ID.test(presetId)) return null;
  if (typeof release !== "string" || !RELEASE.test(release)) return null;
  if (typeof confirmation !== "string" || typeof requestedBy !== "string" || requestedBy === "") return null;
  return { gameId, presetId, release, confirmation, requestedBy };
}

export const RECENT_HOLDER_MS = 24 * 60 * 60 * 1000;
export const EXAMPLE_LIMIT = 20;
export const FILE_POOL = 16;
const CATALOG_ATTEMPTS = 4;

export type HolderRow = Readonly<{ sk: string; addedAt: string | null }>;
export type ReleaseRow = Readonly<{ layout: ReleaseLayout; state: ReleaseItemState; holders: number }>;

export type RetirementTable = Readonly<{
  readRelease(ref: ReleaseRef): Promise<ReleaseRow | null>;
  /** One conditional change of the release state; false when the condition did not hold. `noHolders` adds `holders = 0`. */
  transition(ref: ReleaseRef, from: ReleaseItemState, to: ReleaseItemState, options: Readonly<{ by?: string; noHolders?: boolean }>): Promise<boolean>;
  listHolders(ref: ReleaseRef): Promise<readonly HolderRow[]>;
  /** Deletes the holder and subtracts 1 in one transaction; a holder that is gone is skipped. */
  dropHolder(ref: ReleaseRef, sk: string): Promise<"dropped" | "gone">;
  /** Deletes this release's back-reference to a file and subtracts 1 from `refs`. `drift`: the counter was already 0. */
  removeReference(ref: ReleaseRef, sha256: string): Promise<"removed" | "absent" | "drift">;
  /** Reads the file item; at `refs = 0` and `live` sets `condemned` under that same condition. */
  condemnIfUnused(sha256: string, now: Date): Promise<"condemned" | "kept">;
}>;

export type CatalogDocument = Readonly<{ document: unknown; etag: string }>;

export type CatalogStore = Readonly<{
  read(gameId: string): Promise<CatalogDocument | null>;
  /** Writes under `If-Match: etag`; `lost` when the catalog changed meanwhile. */
  write(gameId: string, document: unknown, etag: string): Promise<"written" | "lost">;
}>;

export type RetirementDeps = Readonly<{
  table: RetirementTable;
  /** Null when the release has no manifest. */
  readManifest(ref: ReleaseRef): Promise<unknown>;
  /** Every source the live check judges: world records, pointers (the pre-generation one too), archives, catalogs. */
  readSources(): Promise<MarkInput>;
  catalogs: CatalogStore;
  now(): Date;
}>;

export type RetirementStatus = "retired" | "refused" | "aborted";

export type RetirementResult = Readonly<{
  status: RetirementStatus;
  gameId: string;
  presetId: string;
  release: string;
  /** Present for `refused` and `aborted`. */
  error?: string;
  examples?: readonly string[];
  holdersRemoved: number;
  referencesRemoved: number;
  condemned: number;
  /** Back-references that had no counter to subtract from. The reconciler would report them as drift. */
  driftRepaired: number;
  catalogChanged: boolean;
  /** True when this run found the release already retired. */
  alreadyRetired: boolean;
}>;

class Stop extends Error {
  readonly code: string;
  readonly examples: readonly string[];
  /** `refused`: nothing changed. `aborted`: the release goes back to live. */
  readonly kind: "refused" | "aborted";
  constructor(kind: "refused" | "aborted", code: string, examples: readonly string[] = []) {
    super(code);
    this.name = "RetirementStop";
    this.kind = kind;
    this.code = code;
    this.examples = examples;
  }
}

/** Runs the work with at most `limit` in flight; stops taking items after the first failure and rethrows it. */
export async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const failed: unknown[] = [];
  const worker = async () => {
    while (failed.length === 0 && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await work(item); // NOSONAR bounded pool: each worker takes one item at a time
      } catch (error) {
        failed.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed.length > 0) throw failed[0];
}

/** Every digest the manifest names, once. An invalid digest means the manifest cannot be trusted to drive a removal. */
export function manifestDigests(manifest: unknown): readonly string[] {
  const digests = new Set<string>();
  for (const item of namedDigests(manifest)) {
    if (!isSha256(item.sha256)) throw new Stop("refused", "invalid_manifest", [item.path]);
    digests.add(item.sha256);
  }
  return [...digests];
}

/** The catalog without this release, or null when it does not list it. */
export function catalogWithoutRelease(document: unknown, presetId: string, release: string): unknown {
  const root = structuredClone(document) as { presets?: Array<Record<string, unknown>> };
  const preset = root.presets?.find((candidate) => candidate.id === presetId);
  const releases = preset?.releases;
  if (preset === undefined || !Array.isArray(releases) || !releases.includes(release)) return null;
  preset.releases = releases.filter((candidate) => candidate !== release);
  const builtFrom = preset.built_from;
  if (builtFrom !== null && typeof builtFrom === "object" && !Array.isArray(builtFrom)) delete (builtFrom as Record<string, unknown>)[release];
  return root;
}

function empty(ref: ReleaseRef, extra: Partial<RetirementResult> & Pick<RetirementResult, "status">): RetirementResult {
  return {
    gameId: ref.gameId, presetId: ref.presetId, release: ref.release,
    holdersRemoved: 0, referencesRemoved: 0, condemned: 0, driftRepaired: 0, catalogChanged: false, alreadyRetired: false,
    ...extra,
  };
}

type Progress = { holdersRemoved: number; catalogChanged: boolean };

function releaseId(ref: ReleaseRef): string {
  return `${ref.gameId}/${ref.presetId}/${ref.release}`;
}

/** Step a: what must never be retired, judged before any change. */
async function checkRetirable(deps: RetirementDeps, ref: ReleaseRef): Promise<Readonly<{ item: ReleaseRow; digests: readonly string[] }>> {
  const item = await deps.table.readRelease(ref);
  if (item === null) throw new Stop("refused", "unknown_release");
  if (item.layout === "legacy") throw new Stop("refused", "legacy_release_protected");
  if (item.state === "building") throw new Stop("refused", "release_not_ready");
  const manifest = await deps.readManifest(ref);
  if (manifest === null) throw new Stop("refused", "manifest_missing");
  if (!manifestUsesObjects(manifest)) throw new Stop("refused", "not_objects_release");
  const digests = manifestDigests(manifest);
  if (item.state !== "retired") {
    const catalog = await deps.catalogs.read(ref.gameId);
    if (catalog !== null) {
      const presets = parsePresetCatalog(catalog.document, ref.gameId);
      if (presets === null) throw new Stop("refused", "catalog_unreadable");
      if (presets.find((preset) => preset.id === ref.presetId)?.latestRelease === ref.release) throw new Stop("refused", "latest_release_protected");
    }
  }
  return { item, digests };
}

/** Step c: nothing live may name the release. Reads every source; a failed read stops the retirement. */
async function liveCheck(deps: RetirementDeps, ref: ReleaseRef): Promise<void> {
  const sources = await deps.readSources();
  const marks = mark(sources);
  const failures = marks.failures;
  if (failures.length > 0) {
    throw new Stop("aborted", "incomplete_live_check", failures.slice(0, EXAMPLE_LIMIT).map((failure) => `${failure.source} ${failure.subject} ${failure.reason}`));
  }
  const id = releaseId(ref);
  // The catalog's own holder is removed below; every other name is a live use.
  const named = marks.holders
    .filter((holder) => holder.release === id && !holder.sk.startsWith("hold#catalog#"))
    .map((holder) => holder.sk);
  if (named.length > 0) throw new Stop("aborted", "release_in_use", [...new Set(named)].sort((a, b) => a.localeCompare(b)).slice(0, EXAMPLE_LIMIT));
}

/** Step d, first half: a holder that may belong to a write in flight stops the retirement. */
async function checkHolders(deps: RetirementDeps, ref: ReleaseRef): Promise<readonly HolderRow[]> {
  const holders = await deps.table.listHolders(ref);
  const now = deps.now().getTime();
  const recent = (holder: HolderRow) => {
    const added = holder.addedAt === null ? Number.NaN : Date.parse(holder.addedAt);
    // A holder with no usable time is treated as new: waiting costs a retry, a wrong removal costs a release.
    return Number.isNaN(added) || now - added < RECENT_HOLDER_MS;
  };
  const builds = holders.filter((holder) => holder.sk.startsWith("hold#build#") && recent(holder));
  if (builds.length > 0) throw new Stop("aborted", "build_in_progress", builds.map((holder) => holder.sk).slice(0, EXAMPLE_LIMIT));
  // Holder first: a generation or backup holder written just before `retiring` may still be waiting for its record.
  const young = holders.filter((holder) => /^hold#(gen|backup)#/.test(holder.sk) && recent(holder));
  if (young.length > 0) throw new Stop("aborted", "holder_recent", young.map((holder) => holder.sk).slice(0, EXAMPLE_LIMIT));
  return holders;
}

/** Step e: the catalog must not list a release that is about to be retired. Read, change, write under the ETag, retry a few times. */
async function dropFromCatalog(deps: RetirementDeps, ref: ReleaseRef): Promise<boolean> {
  for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt += 1) {
    const catalog = await deps.catalogs.read(ref.gameId);
    if (catalog === null) return false;
    const next = catalogWithoutRelease(catalog.document, ref.presetId, ref.release);
    if (next === null) return false;
    if (parsePresetCatalog(next, ref.gameId) === null) throw new Stop("aborted", "catalog_unreadable");
    if (await deps.catalogs.write(ref.gameId, next, catalog.etag) === "written") return true; // NOSONAR retried on a lost race only
  }
  throw new Stop("aborted", "catalog_changed");
}

/** Step g: for each digest remove the back-reference, then condemn a file nobody uses. */
async function cleanReferences(deps: RetirementDeps, ref: ReleaseRef, digests: readonly string[]): Promise<Pick<RetirementResult, "referencesRemoved" | "condemned" | "driftRepaired">> {
  const totals = { referencesRemoved: 0, condemned: 0, driftRepaired: 0 };
  await inPool(digests, FILE_POOL, async (sha256) => {
    const removed = await deps.table.removeReference(ref, sha256);
    if (removed === "removed") totals.referencesRemoved += 1;
    if (removed === "drift") totals.driftRepaired += 1;
    // Also after `absent`: an earlier run may have stopped between the removal and the condemnation.
    if (await deps.table.condemnIfUnused(sha256, deps.now()) === "condemned") totals.condemned += 1;
  });
  return totals;
}

async function toLive(deps: RetirementDeps, ref: ReleaseRef): Promise<void> {
  await deps.table.transition(ref, "retiring", "live", {});
}

/** The coordinates of a request, also when it is invalid, so the refusal can name them. */
function refOf(input: unknown, request: RetirementRequest | null): ReleaseRef {
  if (request !== null) return request;
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    gameId: typeof raw.gameId === "string" ? raw.gameId : "", presetId: typeof raw.presetId === "string" ? raw.presetId : "",
    release: typeof raw.release === "string" ? raw.release : "",
  };
}

/** Step b. A lost condition means another run moved the state: read it again and follow it. True when the release is retired already. */
async function beginRetiring(deps: RetirementDeps, ref: ReleaseRef, item: ReleaseRow, by: string): Promise<boolean> {
  if (item.state !== "live" || await deps.table.transition(ref, "live", "retiring", { by })) return false;
  const now = await deps.table.readRelease(ref);
  if (now?.state === "retired") return true;
  if (now?.state !== "retiring") throw new Stop("refused", "release_not_live");
  return false;
}

/** Step f: each drop is its own transaction. */
async function dropHolders(deps: RetirementDeps, ref: ReleaseRef, holders: readonly HolderRow[], progress: Progress): Promise<void> {
  for (const holder of holders) {
    if (await deps.table.dropHolder(ref, holder.sk) === "dropped") progress.holdersRemoved += 1; // NOSONAR each drop is its own transaction
  }
}

/** Steps c to h: from `retiring` to `retired`. */
async function retireNow(deps: RetirementDeps, ref: ReleaseRef, by: string, progress: Progress): Promise<void> {
  await liveCheck(deps, ref);
  const holders = await checkHolders(deps, ref);
  progress.catalogChanged = await dropFromCatalog(deps, ref);
  await dropHolders(deps, ref, holders, progress);
  if (await deps.table.transition(ref, "retiring", "retired", { by, noHolders: true })) return;
  const now = await deps.table.readRelease(ref);
  if (now?.state !== "retired") throw new Stop("aborted", "holder_appeared");
}

export async function retireRelease(input: unknown, deps: RetirementDeps): Promise<RetirementResult> {
  const request = parseRetirementRequest(input);
  const ref = refOf(input, request);
  if (request === null) return empty(ref, { status: "refused", error: "invalid_request" });
  // The caller checks this too; the Lambda never trusts the caller.
  if (request.confirmation !== retirementConfirmation(ref)) return empty(ref, { status: "refused", error: "invalid_retire_confirmation" });

  const progress: Progress = { holdersRemoved: 0, catalogChanged: false };
  let retiring = false;
  try {
    const { item, digests } = await checkRetirable(deps, ref);
    let alreadyRetired = item.state === "retired";
    if (!alreadyRetired) alreadyRetired = await beginRetiring(deps, ref, item, request.requestedBy);
    if (!alreadyRetired) {
      retiring = true;
      await retireNow(deps, ref, request.requestedBy, progress);
      retiring = false;
    }
    const cleaned = await cleanReferences(deps, ref, digests);
    return empty(ref, { status: "retired", ...progress, ...cleaned, alreadyRetired });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    // Only a deliberate stop puts the release back. A crash leaves `retiring`: the next request resumes it.
    if (error.kind === "aborted" && retiring) await toLive(deps, ref);
    return empty(ref, { status: error.kind, error: error.code, examples: error.examples, ...progress });
  }
}
