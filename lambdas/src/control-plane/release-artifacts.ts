const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELEASE = /^[0-9]+\.[0-9]+$/;

export function releaseArtifactPrefix(gameId: string, presetId: string, release: string): string {
  if (!ID.test(gameId)) throw new Error("invalid_game_id");
  if (!ID.test(presetId)) throw new Error("invalid_preset_id");
  if (!RELEASE.test(release)) throw new Error("invalid_release");
  return `releases/${gameId}/${presetId}/${release}`;
}

export function clientPackKey(gameId: string, presetId: string, release: string): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/client.zip`;
}

/** Where a release stores a mod: the server's set, or the players' own (ADR-0069). */
export type ModStore = "mods" | "client-mods";

/** One mod of a release, named as its manifest records it. */
export function releaseModKey(gameId: string, presetId: string, release: string, file: string, store: ModStore = "mods"): string {
  if (!/^[^/\\]+\.(jar|zip)$/.test(file)) throw new Error("invalid_mod_file");
  return `${releaseArtifactPrefix(gameId, presetId, release)}/${store}/${file}`;
}

export type ManifestMod = Readonly<{ file: string; sha256: string; bytes: number }>;

function manifestMods(value: unknown): readonly ManifestMod[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const mod = entry as Record<string, unknown> | null;
      return typeof mod?.file === "string" && typeof mod.sha256 === "string" && typeof mod.bytes === "number"
        ? [{ file: mod.file, sha256: mod.sha256, bytes: mod.bytes }]
        : [];
    })
    : [];
}

/** The players' mod set when a release records one apart from the server's; null when they install the server's. */
export function manifestClientMods(manifest: unknown): readonly ManifestMod[] | null {
  const client = (manifest as { client?: { kind?: unknown; mods?: unknown } } | null)?.client;
  return client?.kind === "mod-set" ? manifestMods(client.mods) : null;
}

/**
 * Where a release keeps the mod with this digest. A file both sets carry is
 * stored once, with the server's mods; only a players' own mod is in
 * client-mods/. Publication refuses a shared name with two digests.
 */
export function releaseModLocation(manifest: unknown, sha256: string): Readonly<{ file: string; store: ModStore }> | null {
  const onServer = manifestMods((manifest as { server?: { mods?: unknown } } | null)?.server?.mods).find((mod) => mod.sha256 === sha256);
  if (onServer) return { file: onServer.file, store: "mods" };
  const forPlayers = (manifestClientMods(manifest) ?? []).find((mod) => mod.sha256 === sha256);
  return forPlayers ? { file: forPlayers.file, store: "client-mods" } : null;
}

export function releaseManifestKey(gameId: string, presetId: string, release: string): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/manifest.json`;
}
