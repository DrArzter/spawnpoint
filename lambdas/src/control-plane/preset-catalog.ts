export type PresetObservation = Readonly<{
  id: string;
  displayName: string;
  gameId: string;
  repository: string;
  commit: string;
  profileDigest: string;
  latestRelease: string | null;
  buildStatus: "unbuilt" | "building" | "ready" | "failed";
}>;

type ObjectValue = Record<string, unknown>;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE = /^[0-9]+\.[0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

// Catalog documents are produced by the reviewed AWS builder, but they are
// still storage input to the control plane. Parse them as hostile data: one
// malformed game catalog is omitted rather than turning its arbitrary shape
// into worlds somebody can start.
export function parsePresetCatalog(value: unknown, expectedGameId: string): readonly PresetObservation[] | null {
  const root = object(value);
  if (root === null || root.schema_version !== 1 || root.game !== expectedGameId) return null;
  const source = object(root.source);
  if (source === null || typeof source.repository !== "string" || !source.repository.startsWith("https://github.com/")) return null;
  if (typeof source.commit !== "string" || !COMMIT.test(source.commit)) return null;
  if (!Array.isArray(root.presets)) return null;

  const result: PresetObservation[] = [];
  const ids = new Set<string>();
  for (const candidate of root.presets) {
    const preset = object(candidate);
    if (preset === null || typeof preset.id !== "string" || !ID.test(preset.id) || ids.has(preset.id)) return null;
    if (typeof preset.display_name !== "string" || preset.display_name.length < 1 || preset.display_name.length > 80) return null;
    if (typeof preset.profile_digest !== "string" || !SHA256.test(preset.profile_digest)) return null;
    const status = preset.build_status;
    if (status !== "unbuilt" && status !== "building" && status !== "ready" && status !== "failed") return null;
    const latestRelease = preset.latest_release;
    if (latestRelease !== null && (typeof latestRelease !== "string" || !RELEASE.test(latestRelease))) return null;
    if (status === "ready" && latestRelease === null) return null;

    ids.add(preset.id);
    result.push({
      id: preset.id,
      displayName: preset.display_name,
      gameId: expectedGameId,
      repository: source.repository,
      commit: source.commit,
      profileDigest: preset.profile_digest,
      latestRelease,
      buildStatus: status,
    });
  }
  return result;
}
