import { backupGenerationId, backupRelease, type ArchiveMetadata } from "./backup-release.ts";
import type { PresetObservation } from "./preset-catalog.ts";
import {
  digestOfObjectKey, isSha256, manifestPackObject, manifestUsesObjects, type FileItemState, type ReleaseItemState,
} from "./release-objects.ts";
import { manifestClientAddons, manifestClientMods } from "./release-artifacts.ts";
import type { ReleaseState } from "./release-state.ts";
import type { WorldRecord } from "./world-registry.ts";

// The reconciler of ADR-0080. `mark` rebuilds the expected state from the
// sources of truth, `compare` weighs it against the reference table and the
// `objects/` listing. Both are pure: this file has no port that could write.
// release-sweep.ts plans the sweep from the ConsistencyReport. Every other
// finding (missing reference or holder, extra reference, counter drift) stays
// report-only.

export const EXAMPLE_LIMIT = 50;

/** The holder name of a world's pre-generation pointer `worlds/<id>/release.json`, as import-world.sh writes it. */
export const LEGACY_GENERATION = "legacy";

export type ReleaseRef = Readonly<{ gameId: string; presetId: string; release: string }>;

/** `game/preset/release`: the part after `release#` in the table. */
export function releaseId(ref: ReleaseRef): string {
  return `${ref.gameId}/${ref.presetId}/${ref.release}`;
}

export type SourceFailure = Readonly<{ source: string; subject: string; reason: string }>;

export type ManifestSource = Readonly<{ ref: ReleaseRef; manifest: unknown }>;
export type PointerSource = Readonly<{ worldId: string; state: ReleaseState }>;
export type ArchiveSource = Readonly<{ worldId: string; key: string; versionId: string; metadata: ArchiveMetadata }>;
export type CatalogSource = Readonly<{ gameId: string; presets: readonly PresetObservation[] }>;

export type MarkInput = Readonly<{
  /** False when the manifest listing failed, so the manifests below may be only some of them. */
  manifestsListed: boolean;
  manifests: readonly ManifestSource[];
  worlds: readonly WorldRecord[];
  pointers: readonly PointerSource[];
  archives: readonly ArchiveSource[];
  catalogs: readonly CatalogSource[];
  /** Releases the table says are retired: their manifests stay as history and are not marked. */
  retired: ReadonlySet<string>;
  failures: readonly SourceFailure[];
}>;

/** One expected holder: the release, and the sort key of the holder item. */
export type ExpectedHolder = Readonly<{ release: string; sk: string }>;

export type Marks = Readonly<{
  /** Every non-retired manifest's release. */
  liveReleases: ReadonlySet<string>;
  /** Releases whose manifest names objects: the digests each names, with the path that names it first. */
  digests: ReadonlyMap<string, ReadonlyMap<string, string>>;
  holders: readonly ExpectedHolder[];
  /** Every release a manifest or a holder names. */
  namedReleases: ReadonlySet<string>;
  /** Archives that hold no release: no release metadata and no generation id in the key. Informational. */
  archivesWithoutRelease: readonly string[];
  manifestsKnown: boolean;
  failures: readonly SourceFailure[];
}>;

type Named = Readonly<{ sha256: unknown; path: string }>;

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Every digest an objects-v1 manifest names, with the path that names it. */
export function namedDigests(manifest: unknown): readonly Named[] {
  const server = (manifest as { server?: { mods?: unknown; overrides?: unknown } } | null)?.server;
  const named: Named[] = [];
  for (const mod of listOf(server?.mods)) named.push({ sha256: (mod as { sha256?: unknown } | null)?.sha256, path: `mods/${(mod as { file?: unknown } | null)?.file}` });
  for (const item of listOf(server?.overrides)) named.push({ sha256: (item as { sha256?: unknown } | null)?.sha256, path: `overrides/${(item as { path?: unknown } | null)?.path}` });
  for (const mod of manifestClientMods(manifest) ?? []) named.push({ sha256: mod.sha256, path: `client-mods/${mod.file}` });
  for (const addon of manifestClientAddons(manifest)) named.push({ sha256: addon.sha256, path: `client-mods/${addon.file}` });
  for (const pack of ["client", "server", "full"] as const) {
    const object = manifestPackObject(manifest, pack);
    if (object !== null) named.push({ sha256: object.sha256, path: `pack#${pack}` });
  }
  return named;
}

function pointerKey(worldId: string, generationId: string): string {
  return `${worldId}/${generationId}`;
}

type MarkState = Readonly<{
  failures: SourceFailure[];
  holders: Map<string, ExpectedHolder>;
  named: Set<string>;
  withoutRelease: string[];
  hold: (release: string, sk: string) => void;
}>;

type WorldOfRelease = (record: WorldRecord, release: string) => string;

function markManifests(input: MarkInput, state: MarkState, liveReleases: Set<string>, digests: Map<string, Map<string, string>>): void {
  for (const { ref, manifest } of input.manifests) {
    const id = releaseId(ref);
    if (input.retired.has(id)) continue;
    liveReleases.add(id);
    state.named.add(id);
    if (!manifestUsesObjects(manifest)) continue;
    const own = new Map<string, string>();
    for (const item of namedDigests(manifest)) {
      if (isSha256(item.sha256)) {
        if (!own.has(item.sha256)) own.set(item.sha256, item.path);
      } else {
        state.failures.push({ source: "manifest", subject: id, reason: `invalid_digest:${item.path}` });
      }
    }
    digests.set(id, own);
  }
}

function markWorlds(
  input: MarkInput, state: MarkState, pointers: ReadonlyMap<string, ReleaseState>, ofWorld: WorldOfRelease,
): void {
  for (const record of input.worlds) {
    for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
      const sk = `hold#gen#${record.worldId}/${generation.id}`;
      state.hold(ofWorld(record, generation.release), sk);
      const pointer = pointers.get(pointerKey(record.worldId, generation.id));
      if (pointer !== undefined) markPointer(record, pointer, sk, state, ofWorld);
    }
    markLegacyPointer(record, pointers, state, ofWorld);
  }
}

/** A pointer from before generations has no generation id; its holder is `legacy`. */
function markLegacyPointer(
  record: WorldRecord, pointers: ReadonlyMap<string, ReleaseState>, state: MarkState, ofWorld: WorldOfRelease,
): void {
  const legacy = pointers.get(pointerKey(record.worldId, LEGACY_GENERATION));
  if (legacy === undefined) return;
  const sk = `hold#gen#${record.worldId}/${LEGACY_GENERATION}`;
  state.hold(ofWorld(record, legacy.desiredRelease), sk);
  if (legacy.activeRelease !== null) state.hold(ofWorld(record, legacy.activeRelease), sk);
}

function markPointer(record: WorldRecord, pointer: ReleaseState, sk: string, state: MarkState, ofWorld: WorldOfRelease): void {
  state.hold(ofWorld(record, pointer.desiredRelease), sk);
  if (pointer.activeRelease !== null) state.hold(ofWorld(record, pointer.activeRelease), sk);
  for (const run of pointer.releasesRun ?? []) state.hold(ofWorld(record, run.release), sk);
  if (pointer.prePromotionBackup?.release) state.hold(ofWorld(record, pointer.prePromotionBackup.release), sk);
}

function markCatalogs(input: MarkInput, state: MarkState): void {
  for (const catalog of input.catalogs) {
    for (const preset of catalog.presets) {
      for (const release of preset.releases) state.hold(releaseId({ gameId: catalog.gameId, presetId: preset.id, release }), `hold#catalog#${catalog.gameId}`);
    }
  }
}

/** The release an archive belongs to, or null when it cannot be told. */
function archiveRelease(
  archive: ArchiveSource, record: WorldRecord, pointers: ReadonlyMap<string, ReleaseState>,
): string | null {
  const generationId = backupGenerationId(archive.key);
  const generation = [record.currentGeneration, ...record.previousGenerations].find((candidate) => candidate.id === generationId);
  if (generation !== undefined) {
    return backupRelease(generation, archive.metadata, pointers.get(pointerKey(record.worldId, generation.id)) ?? null).release;
  }
  return archive.metadata.release !== null && /^\d+\.\d+$/.test(archive.metadata.release) ? archive.metadata.release : null;
}

export type ArchiveResolution =
  | Readonly<{ kind: "release"; release: string }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unresolved" }>;

/** The pointers of generations by world and generation id, as `resolveArchive` reads them. */
export function pointerIndex(pointers: readonly PointerSource[]): ReadonlyMap<string, ReleaseState> {
  return new Map(pointers.map((pointer) => [pointerKey(pointer.worldId, pointer.state.generationId), pointer.state]));
}

/**
 * The one rule for an archive's release, shared by the reconciler and the registration tool.
 * An archive with no release metadata and no generation id in its key predates ADR-0052:
 * it holds no release. Any other archive that cannot be resolved is unresolved (fail closed).
 */
export function resolveArchive(
  archive: ArchiveSource, record: WorldRecord | undefined, pointers: ReadonlyMap<string, ReleaseState>,
): ArchiveResolution {
  if (archive.metadata.release === null && backupGenerationId(archive.key) === null) return { kind: "none" };
  const release = record === undefined ? null : archiveRelease(archive, record, pointers);
  return release === null ? { kind: "unresolved" } : { kind: "release", release };
}

function markArchives(
  input: MarkInput, state: MarkState, worlds: ReadonlyMap<string, WorldRecord>,
  pointers: ReadonlyMap<string, ReleaseState>, ofWorld: WorldOfRelease,
): void {
  for (const archive of input.archives) {
    const record = worlds.get(archive.worldId);
    const subject = `${archive.key}#${archive.versionId}`;
    const resolved = resolveArchive(archive, record, pointers);
    if (resolved.kind === "none") state.withoutRelease.push(subject);
    else if (resolved.kind === "unresolved" || record === undefined) state.failures.push({ source: "archive", subject, reason: "release_unresolved" });
    else state.hold(ofWorld(record, resolved.release), `hold#backup#${subject}`);
  }
}

export function mark(input: MarkInput): Marks {
  const failures: SourceFailure[] = [...input.failures];
  const liveReleases = new Set<string>();
  const digests = new Map<string, Map<string, string>>();
  const holders = new Map<string, ExpectedHolder>();
  const named = new Set<string>();
  const hold = (release: string, sk: string) => {
    holders.set(`${release}|${sk}`, { release, sk });
    named.add(release);
  };
  const withoutRelease: string[] = [];
  const state: MarkState = { failures, holders, named, withoutRelease, hold };

  markManifests(input, state, liveReleases, digests);

  const worlds = new Map(input.worlds.map((record) => [record.worldId, record]));
  const pointers = pointerIndex(input.pointers);
  const ofWorld: WorldOfRelease = (record, release) => releaseId({ gameId: record.gameId, presetId: record.preset.id, release });

  markWorlds(input, state, pointers, ofWorld);
  markCatalogs(input, state);
  markArchives(input, state, worlds, pointers, ofWorld);

  return {
    liveReleases, digests, holders: [...holders.values()], namedReleases: named, archivesWithoutRelease: withoutRelease,
    manifestsKnown: input.manifestsListed && !failures.some((failure) => failure.source === "manifest" || failure.source === "manifests"),
    failures,
  };
}

// The table, parsed into the views compare needs. Items of another shape are ignored.

export type TableItem = Readonly<Record<string, unknown>>;

export type FileView = Readonly<{
  refs: number;
  state: FileItemState | null;
  bytes: number;
  condemnedAt: string | null;
  deletingAt: string | null;
}>;

export type TableView = Readonly<{
  empty: boolean;
  files: ReadonlyMap<string, FileView>;
  /** digest to the releases that hold a back-reference to it. */
  backReferences: ReadonlyMap<string, ReadonlySet<string>>;
  releases: ReadonlyMap<string, Readonly<{ state: ReleaseItemState | null }>>;
  holders: ReadonlyMap<string, ReadonlySet<string>>;
}>;

type Views = {
  files: Map<string, FileView>;
  backReferences: Map<string, Set<string>>;
  releases: Map<string, { state: ReleaseItemState | null }>;
  holders: Map<string, Set<string>>;
};

function fileViewOf(item: TableItem): FileView {
  return {
    refs: Number(item.refs), state: (item.state as FileItemState | undefined) ?? null, bytes: Number(item.bytes ?? 0),
    condemnedAt: typeof item.condemned_at === "string" ? item.condemned_at : null,
    deletingAt: typeof item.deleting_at === "string" ? item.deleting_at : null,
  };
}

function addFileItem(views: Views, digest: string, sk: string, item: TableItem): void {
  if (sk === "meta") views.files.set(digest, fileViewOf(item));
  else if (sk.startsWith("release#")) views.backReferences.set(digest, (views.backReferences.get(digest) ?? new Set()).add(sk.slice("release#".length)));
}

function addReleaseItem(views: Views, id: string, sk: string, item: TableItem): void {
  if (sk === "meta") views.releases.set(id, { state: (item.state as ReleaseItemState | undefined) ?? null });
  else if (sk.startsWith("hold#")) views.holders.set(id, (views.holders.get(id) ?? new Set()).add(sk));
}

export function tableView(items: readonly TableItem[]): TableView {
  const views: Views = { files: new Map(), backReferences: new Map(), releases: new Map(), holders: new Map() };
  for (const item of items) {
    const { pk, sk } = item;
    if (typeof pk !== "string" || typeof sk !== "string") continue;
    if (pk.startsWith("file#")) addFileItem(views, pk.slice("file#".length), sk, item);
    else if (pk.startsWith("release#")) addReleaseItem(views, pk.slice("release#".length), sk, item);
  }
  return { empty: items.length === 0, ...views };
}

export const DIFF_CLASSES = [
  "missing_holder", "missing_reference", "missing_object",
  "extra_reference", "counter_drift", "orphan_object", "stuck_deleting", "unregistered_release", "unknown_object_key",
  "archive_without_release",
] as const;
export type DiffClass = (typeof DIFF_CLASSES)[number];

/** Dangerous (design 4.8): a missing reference or holder, or a named object that is not in S3. */
export const DANGEROUS_CLASSES: readonly DiffClass[] = ["missing_holder", "missing_reference", "missing_object"];

export type ClassReport = Readonly<{ count: number; examples: readonly string[] }>;

export type ConsistencyReport = Readonly<{
  generatedAt: string;
  /** Taken before the first read: a delete needs a mark from a run that started after `condemned_at`. */
  startedAt: string;
  mode: "report";
  /** True only when every source was read. */
  complete: boolean;
  /** Only a complete run may sweep. */
  sweepable: boolean;
  table_empty: boolean;
  /** Classes that could not be judged in this run, with the reason. */
  skipped: readonly Readonly<{ class: DiffClass; reason: string }>[];
  failures: readonly SourceFailure[];
  dangerous: number;
  classes: Readonly<Record<DiffClass, ClassReport>>;
}>;

/** `sizes` maps a key to its bytes; a key without a size counts as 0. */
export type Listing = Readonly<{ keys: readonly string[]; sizes?: ReadonlyMap<string, number> }> | null;

/**
 * Digests that a building release holds a back-reference to. The builder
 * uploads before it writes the manifest, so no manifest names them yet.
 * A holder `hold#build#...` is never derived from the sources and never compared.
 */
export function buildingDigests(table: TableView | null): ReadonlySet<string> {
  const building = new Set<string>();
  for (const [digest, releases] of table?.backReferences ?? []) {
    if ([...releases].some((release) => table?.releases.get(release)?.state === "building")) building.add(digest);
  }
  return building;
}

type Findings = Record<DiffClass, string[]>;

type Skip = (names: readonly DiffClass[], reason: string) => void;

const TABLE_CLASSES = ["missing_holder", "missing_reference", "extra_reference", "counter_drift", "stuck_deleting"] as const;

/** The digests the listing holds; keys that are not object keys are findings. */
function digestsListed(listing: Listing, found: Findings): Set<string> {
  const objects = new Set<string>();
  if (listing === null) return objects;
  for (const key of listing.keys) {
    const digest = digestOfObjectKey(key);
    if (digest === null) found.unknown_object_key.push(key);
    else objects.add(digest);
  }
  return objects;
}

export function digestsNamed(marks: Marks): Set<string> {
  const named = new Set<string>();
  for (const own of marks.digests.values()) for (const digest of own.keys()) named.add(digest);
  return named;
}

function findMissingObjects(marks: Marks, objects: ReadonlySet<string>, found: Findings): void {
  for (const [release, own] of marks.digests) {
    for (const digest of own.keys()) if (!objects.has(digest)) found.missing_object.push(`release#${release} -> file#${digest}`);
  }
}

function findMissingHolders(marks: Marks, table: TableView, found: Findings): void {
  for (const { release, sk } of marks.holders) {
    if (table.releases.has(release) && !table.holders.get(release)?.has(sk)) found.missing_holder.push(`release#${release} / ${sk}`);
  }
}

function findMissingReferences(marks: Marks, table: TableView, found: Findings): void {
  for (const [release, own] of marks.digests) {
    if (!table.releases.has(release)) continue;
    for (const digest of own.keys()) {
      if (!table.backReferences.get(digest)?.has(release)) found.missing_reference.push(`release#${release} -> file#${digest}`);
    }
  }
}

function findExtraReferences(marks: Marks, table: TableView, found: Findings): void {
  // A building release holds references before its manifest exists.
  for (const [digest, releases] of table.backReferences) {
    for (const release of releases) {
      if (table.releases.get(release)?.state !== "building" && marks.digests.get(release)?.has(digest) !== true) found.extra_reference.push(`file#${digest} <- release#${release}`);
    }
  }
}

function findCounterDrift(table: TableView, found: Findings): void {
  for (const digest of new Set([...table.files.keys(), ...table.backReferences.keys()])) {
    const actual = table.backReferences.get(digest)?.size ?? 0;
    const item = table.files.get(digest);
    if (item === undefined) found.counter_drift.push(`file#${digest} has no meta, ${actual} back-references`);
    else if (item.refs !== actual) found.counter_drift.push(`file#${digest} refs=${item.refs} back-references=${actual}`);
    if (item?.state === "deleting") found.stuck_deleting.push(`file#${digest}`);
  }
}

function compareTable(marks: Marks, table: TableView | null, found: Findings, skip: Skip): void {
  if (table === null) {
    skip([...TABLE_CLASSES, "unregistered_release"], "table_unreadable");
    return;
  }
  for (const release of marks.namedReleases) if (!table.releases.has(release)) found.unregistered_release.push(`release#${release}`);
  if (table.empty) {
    skip(TABLE_CLASSES, "table_empty");
    return;
  }
  findMissingHolders(marks, table, found);
  findMissingReferences(marks, table, found);
  if (marks.manifestsKnown) findExtraReferences(marks, table, found);
  else skip(["extra_reference"], "manifests_incomplete");
  findCounterDrift(table, found);
}

function findOrphans(
  marks: Marks, listing: Listing, objects: ReadonlySet<string>, named: ReadonlySet<string>, table: TableView | null,
  found: Findings, skip: Skip,
): void {
  if (listing === null) return;
  if (!marks.manifestsKnown) {
    skip(["orphan_object"], "manifests_incomplete");
    return;
  }
  // The builder uploads objects before the manifest, so a building release's digests are not orphans.
  const building = buildingDigests(table);
  for (const digest of objects) if (!named.has(digest) && !building.has(digest)) found.orphan_object.push(`file#${digest}`);
}

function summarise(found: Findings): Record<DiffClass, ClassReport> {
  return Object.fromEntries(DIFF_CLASSES.map((name) => {
    const list = [...new Set(found[name])].sort((a, b) => a.localeCompare(b));
    return [name, { count: list.length, examples: list.slice(0, EXAMPLE_LIMIT) }];
  })) as unknown as Record<DiffClass, ClassReport>;
}

/**
 * `table` is null when it could not be read; `listing` is null when `objects/`
 * could not be listed. A class that needs a missing source is skipped, not guessed.
 */
export function compare(marks: Marks, table: TableView | null, listing: Listing, generatedAt: string, startedAt: string): ConsistencyReport {
  const found = Object.fromEntries(DIFF_CLASSES.map((name) => [name, [] as string[]])) as Findings;
  const skipped: { class: DiffClass; reason: string }[] = [];
  const skip: Skip = (names, reason) => { for (const name of names) skipped.push({ class: name, reason }); };

  const objects = digestsListed(listing, found);
  const named = digestsNamed(marks);
  found.archive_without_release.push(...marks.archivesWithoutRelease);

  if (listing === null) skip(["missing_object", "orphan_object"], "objects_listing_failed");
  else findMissingObjects(marks, objects, found);

  compareTable(marks, table, found, skip);
  findOrphans(marks, listing, objects, named, table, found, skip);

  const classes = summarise(found);
  const complete = marks.failures.length === 0 && table !== null && listing !== null;
  return {
    generatedAt, startedAt, mode: "report", complete, sweepable: complete, table_empty: table?.empty ?? false,
    skipped, failures: marks.failures.slice(0, EXAMPLE_LIMIT),
    dangerous: DANGEROUS_CLASSES.reduce((sum, name) => sum + classes[name].count, 0),
    classes,
  };
}
