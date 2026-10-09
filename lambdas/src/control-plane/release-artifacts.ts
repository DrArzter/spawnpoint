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

/** One server mod of a release, named as its manifest records it. */
export function releaseModKey(gameId: string, presetId: string, release: string, file: string): string {
  if (!/^[^/\\]+\.(jar|zip)$/.test(file)) throw new Error("invalid_mod_file");
  return `${releaseArtifactPrefix(gameId, presetId, release)}/mods/${file}`;
}

export function releaseManifestKey(gameId: string, presetId: string, release: string): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/manifest.json`;
}
