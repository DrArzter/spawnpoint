const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RELEASE = /^\d+\.\d+$/;

export function releaseArtifactPrefix(gameId: string, presetId: string, release: string): string {
  if (!ID.test(gameId)) throw new Error("invalid_game_id");
  if (!ID.test(presetId)) throw new Error("invalid_preset_id");
  if (!RELEASE.test(release)) throw new Error("invalid_release");
  return `releases/${gameId}/${presetId}/${release}`;
}

export function clientPackKey(gameId: string, presetId: string, release: string): string {
  return releasePackKey(gameId, presetId, release, "client");
}

/** A release's packs: what players install, and, with side lists (ADR-0069), the server's set and every mod. */
export const RELEASE_PACKS = ["client", "server", "full"] as const;
export type ReleasePack = (typeof RELEASE_PACKS)[number];

export function releasePackKey(gameId: string, presetId: string, release: string, pack: ReleasePack): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/${pack}.zip`;
}

/** Where a release stores a mod: the server's set, or the players' own (ADR-0069). */
export type ModStore = "mods" | "client-mods";

/** One mod of a release, named as its manifest records it. */
export function releaseModKey(gameId: string, presetId: string, release: string, file: string, store: ModStore = "mods"): string {
  if (!/^[^/\\]+\.(jar|zip)$/.test(file)) throw new Error("invalid_mod_file");
  return `${releaseArtifactPrefix(gameId, presetId, release)}/${store}/${file}`;
}

/** Where the build fetched a mod (descriptive; releases built before it record none). */
export const MOD_SOURCES = ["curseforge", "modrinth", "github"] as const;
export type ModSource = (typeof MOD_SOURCES)[number];

export function manifestModSource(value: unknown): ModSource | undefined {
  return MOD_SOURCES.find((source) => source === value);
}

export type ManifestMod = Readonly<{ file: string; sha256: string; bytes: number; source?: ModSource }>;

function manifestMods(value: unknown): readonly ManifestMod[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const mod = entry as Record<string, unknown> | null;
      if (typeof mod?.file !== "string" || typeof mod.sha256 !== "string" || typeof mod.bytes !== "number") return [];
      const source = manifestModSource(mod.source);
      return [{ file: mod.file, sha256: mod.sha256, bytes: mod.bytes, ...(source ? { source } : {}) }];
    })
    : [];
}

/** The server's mods as the manifest records them; entries without a file, digest and size are left out. */
export function manifestServerMods(manifest: unknown): readonly ManifestMod[] {
  return manifestMods((manifest as { server?: { mods?: unknown } } | null)?.server?.mods);
}

/** The players' mod set when a release records one apart from the server's; null when they install the server's. */
export function manifestClientMods(manifest: unknown): readonly ManifestMod[] | null {
  const client = (manifest as { client?: { kind?: unknown; mods?: unknown } } | null)?.client;
  return client?.kind === "mod-set" ? manifestMods(client.mods) : null;
}

export type AddonSide = "both" | "server" | "client";
export type ManifestAddon = Readonly<ManifestMod & { side: AddonSide }>;

/** The extra mods a modpack release pins on top of its pack (ADR-0077); empty when it has none. */
export function manifestClientAddons(manifest: unknown): readonly ManifestAddon[] {
  const client = (manifest as { client?: { kind?: unknown; addons?: unknown } } | null)?.client;
  if (client?.kind !== "curseforge-modpack" || !Array.isArray(client.addons)) return [];
  return client.addons.flatMap((entry) => {
    const side = (entry as { side?: unknown } | null)?.side;
    if (side !== "both" && side !== "server" && side !== "client") return [];
    return manifestMods([entry]).map((mod) => ({ ...mod, side }));
  });
}

/**
 * Where a release keeps the mod with this digest. A file both sets carry is
 * stored once, with the server's mods; only a players' own mod, or a client
 * addon, is in client-mods/. Publication refuses a shared name with two digests.
 */
export function releaseModLocation(manifest: unknown, sha256: string): Readonly<{ file: string; store: ModStore }> | null {
  const onServer = manifestMods((manifest as { server?: { mods?: unknown } } | null)?.server?.mods).find((mod) => mod.sha256 === sha256);
  if (onServer) return { file: onServer.file, store: "mods" };
  const forPlayers = [...manifestClientMods(manifest) ?? [], ...manifestClientAddons(manifest).filter((addon) => addon.side === "client")]
    .find((mod) => mod.sha256 === sha256);
  return forPlayers ? { file: forPlayers.file, store: "client-mods" } : null;
}

export function releaseManifestKey(gameId: string, presetId: string, release: string): string {
  return `${releaseArtifactPrefix(gameId, presetId, release)}/manifest.json`;
}

/** The name a player's browser saves a downloaded file under, whatever characters it holds. */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** What a pack is called when a player saves it. Objects are named by digest, so the name must come from here. */
export function packAttachmentName(presetId: string, release: string, pack: ReleasePack): string {
  return `${presetId}-${release}-${pack}.zip`;
}

/** Short-lived links to a release's files (ADR-0065, ADR-0069), named for what they hold. */
export type ReleaseLinks = Readonly<{
  /** One pack of a release, or null when it was not published. */
  pack: (gameId: string, presetId: string, release: string, pack: ReleasePack, expiresIn: number) => Promise<string | null>;
  /** One mod of a release; a digest names the object of an objects-v1 release. */
  mod: (gameId: string, presetId: string, release: string, location: Readonly<{ file: string; store: ModStore }>, expiresIn: number, objectDigest?: string) => Promise<string>;
}>;
