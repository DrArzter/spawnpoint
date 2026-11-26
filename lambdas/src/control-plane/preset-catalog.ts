import type { Footprint } from "../domain/placement.ts";
import type { BuildView } from "./release-builds.ts";

export type PresetObservation = Readonly<{
  id: string;
  displayName: string;
  gameId: string;
  repository: string;
  commit: string;
  profileDigest: string;
  releases: readonly string[];
  /** The newest published release, whatever revision it was built from. */
  latestRelease: string | null;
  /** The state of the build of the current revision (the profile digest), not of the releases. */
  buildStatus: "unbuilt" | "building" | "ready" | "failed";
  /** Releases built from an older revision than the current profile digest (ADR-0042). */
  olderReleases?: readonly string[];
  buildAvailable?: boolean;
  build?: BuildView;
  /** What a session of this preset is placed with, when it needs more than its game's (ADR-0054). */
  footprint?: Footprint;
}>;

type ObjectValue = Record<string, unknown>;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE = /^\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

type CatalogSource = Readonly<{ repository: string; commit: string }>;

function parseSource(value: unknown): CatalogSource | null {
  const source = object(value);
  if (source === null || typeof source.repository !== "string" || !source.repository.startsWith("https://github.com/")) return null;
  if (typeof source.commit !== "string" || !COMMIT.test(source.commit)) return null;
  return { repository: source.repository, commit: source.commit };
}

function parseReleases(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((release) => typeof release === "string" && RELEASE.test(release))) return null;
  const releases = value as string[];
  return new Set(releases).size === releases.length ? releases : null;
}

// `built_from` records the profile digest and source commit each release was
// built from. A release whose digest is not the entry's own is older. A null
// digest is a release recovered without its revision: older by definition.
// Absent for a legacy entry, whose releases all belong to the current digest.
function parseOlderReleases(value: unknown, releases: readonly string[], digest: string): string[] | null {
  if (value === undefined) return [];
  const builtFrom = object(value);
  if (builtFrom === null) return null;
  const older: string[] = [];
  for (const [release, revision] of Object.entries(builtFrom)) {
    const record = object(revision);
    if (!releases.includes(release) || record === null) return null;
    if (record.profile_digest !== null && (typeof record.profile_digest !== "string" || !SHA256.test(record.profile_digest))) return null;
    if (typeof record.source_commit !== "string" || !COMMIT.test(record.source_commit)) return null;
    if (record.profile_digest !== digest) older.push(release);
  }
  return releases.filter((release) => older.includes(release));
}

// Absent is no footprint of its own; anything present must be a whole one.
function parseFootprint(value: unknown): Footprint | undefined | null {
  if (value === undefined) return undefined;
  const footprint = object(value);
  if (footprint === null || Object.keys(footprint).some((key) => key !== "memory_mib" && key !== "cores")) return null;
  const { memory_mib: memoryMiB, cores } = footprint;
  if (typeof memoryMiB !== "number" || !Number.isInteger(memoryMiB) || memoryMiB <= 0) return null;
  if (typeof cores !== "number" || !(cores > 0)) return null;
  return { memoryMiB, cores };
}

function parsePreset(candidate: unknown, source: CatalogSource, gameId: string, ids: ReadonlySet<string>): PresetObservation | null {
  const preset = object(candidate);
  if (preset === null || typeof preset.id !== "string" || !ID.test(preset.id) || ids.has(preset.id)) return null;
  if (typeof preset.display_name !== "string" || preset.display_name.length < 1 || preset.display_name.length > 80) return null;
  if (typeof preset.profile_digest !== "string" || !SHA256.test(preset.profile_digest)) return null;
  const sourceCommit = preset.source_commit === undefined ? source.commit : preset.source_commit;
  if (typeof sourceCommit !== "string" || !COMMIT.test(sourceCommit)) return null;
  const status = preset.build_status;
  if (status !== "unbuilt" && status !== "building" && status !== "ready" && status !== "failed") return null;
  const latestRelease = preset.latest_release;
  if (latestRelease !== null && (typeof latestRelease !== "string" || !RELEASE.test(latestRelease))) return null;
  const releases = parseReleases(preset.releases);
  if (releases === null) return null;
  if (status === "ready" && (latestRelease === null || !releases.includes(latestRelease))) return null;
  if (status !== "ready" && latestRelease !== null && !releases.includes(latestRelease)) return null;
  const olderReleases = parseOlderReleases(preset.built_from, releases, preset.profile_digest);
  if (olderReleases === null) return null;
  const footprint = parseFootprint(preset.footprint);
  if (footprint === null) return null;
  return {
    id: preset.id,
    displayName: preset.display_name,
    gameId,
    repository: source.repository,
    commit: sourceCommit,
    profileDigest: preset.profile_digest,
    releases,
    latestRelease,
    buildStatus: status,
    olderReleases,
    ...(footprint === undefined ? {} : { footprint }),
  };
}

/** A release of this preset built from an older revision than the current profile digest. */
export function isOlderRevision(preset: Pick<PresetObservation, "olderReleases">, release: string): boolean {
  return preset.olderReleases?.includes(release) ?? false;
}

/**
 * Whether a world that exists may use a published release: start, restore and
 * promote (ADR-0042). A release of an older revision stays usable while the
 * current revision is not built, exactly as it was before the digest changed.
 */
export function usableByExistingWorld(preset: Pick<PresetObservation, "releases" | "buildStatus" | "olderReleases">, release: string): boolean {
  return preset.releases.includes(release) && (preset.buildStatus === "ready" || isOlderRevision(preset, release));
}

/** Whether a new world or a new wipe may open on a release: only one built from the current revision. */
export function usableByNewWipe(preset: Pick<PresetObservation, "releases" | "olderReleases">, release: string): boolean {
  return preset.releases.includes(release) && !isOlderRevision(preset, release);
}

// Catalog documents are produced by the reviewed AWS builder, but they are
// still storage input to the control plane. Parse them as hostile data: one
// malformed game catalog is omitted rather than turning its arbitrary shape
// into worlds somebody can start.
export function parsePresetCatalog(value: unknown, expectedGameId: string): readonly PresetObservation[] | null {
  const root = object(value);
  if (root?.schema_version !== 2 || root.game !== expectedGameId) return null;
  const source = parseSource(root.source);
  if (source === null || !Array.isArray(root.presets)) return null;

  const result: PresetObservation[] = [];
  const ids = new Set<string>();
  for (const candidate of root.presets) {
    const preset = parsePreset(candidate, source, expectedGameId, ids);
    if (preset === null) return null;
    ids.add(preset.id);
    result.push(preset);
  }
  return result;
}
