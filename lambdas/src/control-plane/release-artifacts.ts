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

export function releaseManifestKey(gameId: string, presetId: string, release: string): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/manifest.json`;
}
