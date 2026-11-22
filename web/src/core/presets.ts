import type { Preset } from "../model";

/*
 * Which releases of a preset a person may pick (ADR-0042). A preset keeps every
 * release it published. A release built from an older revision of the preset
 * still serves a world that exists, but a new world or a new wipe opens only
 * on a release of the current revision. The control plane enforces the same
 * rule; these helpers keep the panel from offering what it would refuse.
 */

type Releases = Pick<Preset, "releases" | "latestRelease" | "olderReleases" | "buildStatus">;

export function isOlderRevision(preset: Pick<Preset, "olderReleases">, release: string): boolean {
  return preset.olderReleases?.includes(release) ?? false;
}

/** The releases a new world or a new wipe may open on, oldest first. */
export function startableReleases(preset: Releases): readonly string[] {
  return preset.releases.filter((release) => !isOlderRevision(preset, release));
}

/** The newest of those, or null when only older revisions are published. */
export function startableLatest(preset: Releases): string | null {
  const releases = startableReleases(preset);
  return preset.latestRelease !== null && releases.includes(preset.latestRelease) ? preset.latestRelease : releases.at(-1) ?? null;
}

/** The releases an existing world may be promoted to: ready ones, and older-revision ones while the new revision is not built. */
export function promotableReleases(preset: Releases): readonly string[] {
  return preset.releases.filter((release) => preset.buildStatus === "ready" || isOlderRevision(preset, release));
}

/** A published release exists, but none is of the current revision, which is not ready. */
export function onlyOlderRevisions(preset: Releases): boolean {
  return preset.buildStatus !== "ready" && preset.releases.length > 0 && preset.releases.every((release) => isOlderRevision(preset, release));
}
