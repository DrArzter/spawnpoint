/*
 * A world's own configuration files (ADR-0093). A release brings a game's
 * config files and replaces them at every start; a world may keep its own
 * version of any text file inside the game's config roots, and the start
 * writes it after the release's. The edits belong to the world and outlive
 * its wipes, like its whitelist and its game settings.
 */

/** A game's rules for the files a world may edit, as its manifest states them. */
export type ConfigFileRules = Readonly<{
  roots: readonly string[];
  maxBytes: number;
  textExtensions: readonly string[];
}>;

/** One file the world keeps, by the digest of its stored bytes. */
export type WorldConfigFile = Readonly<{
  sha256: string;
  bytes: number;
  /** The release's file the edit started from; null for a file the release does not have. */
  baseSha256: string | null;
  updatedAt: string;
  updatedBy: Readonly<{ identityId: string; displayName: string }>;
}>;

export type WorldConfigFiles = Readonly<Record<string, WorldConfigFile>>;

/** One release file inside the config roots, as the release manifest lists it. */
export type ReleaseConfigFile = Readonly<{ path: string; sha256: string; bytes: number }>;

const SEGMENT = /^[A-Za-z0-9._+-][A-Za-z0-9 ._+-]{0,127}$/;

/** A relative path inside one of the roots: no empty, dot or hidden segments, at most eight deep. */
export function configPathValid(path: unknown, rules: ConfigFileRules): path is string {
  if (typeof path !== "string" || path.length > 512) return false;
  const segments = path.split("/");
  if (segments.length < 2 || segments.length > 8 || !rules.roots.includes(segments[0]!)) return false;
  return segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

export function textExtension(path: string, rules: ConfigFileRules): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && rules.textExtensions.includes(name.slice(dot + 1).toLowerCase());
}

/** A world-data path (ADR-0077) is the world's running data, never a file to edit. */
export function insideWorldData(path: string, worldData: readonly string[]): boolean {
  return worldData.some((owned) => path === owned || path.startsWith(`${owned}/`) || owned.startsWith(`${path}/`));
}

/** Text the panel may store: valid UTF-8, no NUL, within the limit. */
export function configText(bytes: Uint8Array, rules: ConfigFileRules): Readonly<{ ok: true; text: string } | { ok: false; error: "config_file_too_large" | "config_file_not_text" }> {
  if (bytes.byteLength > rules.maxBytes) return { ok: false, error: "config_file_too_large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "config_file_not_text" };
  }
  return text.includes("\u0000") ? { ok: false, error: "config_file_not_text" } : { ok: true, text };
}

/** Where a world's own files and its release's files are read and written (ADR-0093). */
export type ConfigFileStore = Readonly<{
  /** Stores one version of a world's file under its digest; storing the same bytes twice is harmless. */
  putWorldFile: (worldId: string, sha256: string, bytes: Uint8Array) => Promise<void>;
  readWorldFile: (worldId: string, sha256: string) => Promise<Uint8Array | null>;
  /** One file of a release; `objects` when the release keeps its files by digest (objects-v1). */
  readReleaseFile: (release: Readonly<{ gameId: string; presetId: string; release: string; objects: boolean }>, file: ReleaseConfigFile) => Promise<Uint8Array | null>;
}>;

/** The key of one stored version of a world's file. */
export function worldConfigFileKey(worldId: string, sha256: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(worldId) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("invalid_world_config_key");
  return `worlds/${worldId}/config/${sha256}`;
}
