import { manifestUsesObjects, releaseItemPk, type ReleaseItemState, type ReleaseLayout } from "./release-objects.ts";
import { holderKey, type HolderRole, type ReleaseRef } from "./release-refs.ts";
import type { ReleaseState } from "./release-state.ts";
import type { WorldRecord } from "./world-registry.ts";

// Plans the registration of releases that exist before the reference table
// (ADR-0080, design 4.9). Pure: the tool lists and reads, this decides. A
// legacy release is registered `live` with no file references, then gets the
// holders that name it today. It is never swept and never retired.

export type ManifestListing = Readonly<{ ref: ReleaseRef; manifest: unknown }>;

export type KnownRelease = Readonly<{ layout: ReleaseLayout; state: ReleaseItemState }>;

/** A release pointer of a generation, or the pre-generation pointer of a world (`worlds/<id>/release.json`, generation id `legacy`). */
export type PointerSource = Readonly<{ worldId: string; generationId: string; desired: string; active: string | null; runs: readonly string[]; prePromotion: string | null }>;

export type RegistrationInput = Readonly<{
  manifests: readonly ManifestListing[];
  /** What the table holds for each release id (`releaseItemPk`), when it holds anything. */
  known: ReadonlyMap<string, KnownRelease>;
  catalogs: readonly Readonly<{ gameId: string; presets: readonly Readonly<{ id: string; releases: readonly string[] }>[] }>[];
  worlds: readonly WorldRecord[];
  pointers: readonly Readonly<{ worldId: string; state: ReleaseState }>[];
  legacyPointers: readonly PointerSource[];
  /** Sources the tool could not read or parse; each one is reported, never skipped. */
  unreadable: readonly Readonly<{ source: string; subject: string; reason: string }>[];
}>;

export type HolderPlan = Readonly<{ ref: ReleaseRef; key: string; roles: readonly HolderRole[] }>;

export type ReportKind = "objects_layout" | "not_live" | "no_manifest" | "unreadable";
export type ReportLine = Readonly<{ kind: ReportKind; subject: string; reason: string }>;

export type RegistrationPlan = Readonly<{
  register: readonly ReleaseRef[];
  holders: readonly HolderPlan[];
  report: readonly ReportLine[];
}>;

const id = (ref: ReleaseRef) => releaseItemPk(ref.gameId, ref.presetId, ref.release);

export function pointerSources(pointers: RegistrationInput["pointers"]): readonly PointerSource[] {
  return pointers.map(({ worldId, state }) => ({
    worldId, generationId: state.generationId, desired: state.desiredRelease, active: state.activeRelease,
    runs: (state.releasesRun ?? []).map((run) => run.release), prePromotion: state.prePromotionBackup?.release ?? null,
  }));
}

type Wanted = Map<string, { ref: ReleaseRef; key: string; roles: Set<HolderRole> }>;
type Sources = Pick<RegistrationInput, "catalogs" | "worlds" | "pointers" | "legacyPointers">;

type Want = (ref: ReleaseRef, key: string, role: HolderRole) => void;
type WorldIds = ReadonlyMap<string, Readonly<{ gameId: string; presetId: string }>>;

function wantCatalogs(input: Sources, want: Want): void {
  for (const catalog of input.catalogs) {
    for (const preset of catalog.presets) {
      for (const release of preset.releases) want({ gameId: catalog.gameId, presetId: preset.id, release }, holderKey.catalog(catalog.gameId), "catalog");
    }
  }
}

function wantGenerations(input: Sources, worlds: WorldIds, want: Want): void {
  for (const record of input.worlds) {
    for (const generation of [record.currentGeneration, ...record.previousGenerations]) {
      want({ ...worlds.get(record.worldId)!, release: generation.release }, holderKey.generation(record.worldId, generation.id), "origin");
    }
  }
}

function wantPointer(pointer: PointerSource, world: Readonly<{ gameId: string; presetId: string }>, want: Want): void {
  const key = holderKey.generation(pointer.worldId, pointer.generationId);
  want({ ...world, release: pointer.desired }, key, "desired");
  if (pointer.active !== null) want({ ...world, release: pointer.active }, key, "active");
  for (const release of pointer.runs) want({ ...world, release }, key, "run");
  if (pointer.prePromotion !== null) want({ ...world, release: pointer.prePromotion }, key, "pre-promotion");
}

// What names a release today: the catalog, each generation of a record, each pointer.
function collect(input: Sources): Readonly<{ wanted: Wanted; orphans: readonly string[] }> {
  const wanted: Wanted = new Map();
  const orphans: string[] = [];
  const want: Want = (ref, key, role) => {
    const slot = `${id(ref)}|${key}`;
    const entry = wanted.get(slot) ?? { ref, key, roles: new Set<HolderRole>() };
    entry.roles.add(role);
    wanted.set(slot, entry);
  };
  wantCatalogs(input, want);
  const worlds: WorldIds = new Map(input.worlds.map((record) => [record.worldId, { gameId: record.gameId, presetId: record.preset.id }]));
  wantGenerations(input, worlds, want);
  for (const pointer of [...pointerSources(input.pointers), ...input.legacyPointers]) {
    const world = worlds.get(pointer.worldId);
    if (world === undefined) orphans.push(`${pointer.worldId}/${pointer.generationId}`);
    else wantPointer(pointer, world, want);
  }
  return { wanted, orphans };
}

/** Every release the table may need an answer for: the listed manifests and whatever names a release. */
export function candidateReleases(input: Sources & Pick<RegistrationInput, "manifests">): readonly ReleaseRef[] {
  const refs = new Map(input.manifests.map((listing) => [id(listing.ref), listing.ref]));
  for (const { ref } of collect(input).wanted.values()) refs.set(id(ref), ref);
  return [...refs.values()];
}

function unusableReason(known: KnownRelease | undefined, listing: ManifestListing | undefined): Readonly<{ kind: ReportKind; reason: string }> | null {
  if (known?.layout === "objects" || (listing !== undefined && manifestUsesObjects(listing.manifest))) {
    return { kind: "objects_layout", reason: "an objects-v1 release is registered by the builder; nothing is written for it here" };
  }
  if (known !== undefined && known.state !== "live") return { kind: "not_live", reason: `the release is ${known.state}; no holder is added` };
  if (known === undefined && listing === undefined) return { kind: "no_manifest", reason: "a catalog, record or pointer names it, but no manifest exists" };
  return null;
}

export function planLegacyRegistration(input: RegistrationInput): RegistrationPlan {
  const report: ReportLine[] = input.unreadable.map((line) => ({ kind: "unreadable", subject: `${line.source} ${line.subject}`, reason: line.reason }));
  const manifests = new Map(input.manifests.map((listing) => [id(listing.ref), listing]));
  const reported = new Set<string>();
  const { wanted, orphans } = collect(input);
  for (const orphan of orphans) report.push({ kind: "unreadable", subject: `pointer ${orphan}`, reason: "no world record names this world" });

  const note = (kind: ReportKind, subject: string, reason: string) => {
    const line = `${kind}|${subject}`;
    if (reported.has(line)) return;
    reported.add(line);
    report.push({ kind, subject, reason });
  };

  // Which releases may be written for, and why not.
  const usable = new Map<string, boolean>();
  const check = (ref: ReleaseRef): boolean => {
    const slot = id(ref);
    const cached = usable.get(slot);
    if (cached !== undefined) return cached;
    const subject = slot.slice("release#".length);
    const known = input.known.get(slot);
    const listing = manifests.get(slot);
    const problem = unusableReason(known, listing);
    if (problem !== null) note(problem.kind, subject, problem.reason);
    const ok = problem === null;
    usable.set(slot, ok);
    return ok;
  };

  const register: ReleaseRef[] = [];
  for (const listing of manifests.values()) {
    if (check(listing.ref) && !input.known.has(id(listing.ref))) register.push(listing.ref);
  }
  const plannedHolders: HolderPlan[] = [];
  for (const entry of wanted.values()) {
    if (check(entry.ref)) plannedHolders.push({ ref: entry.ref, key: entry.key, roles: [...entry.roles] });
  }
  return { register, holders: plannedHolders, report };
}
