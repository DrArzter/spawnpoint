// A world's own configuration files (ADR-0093): a release's config files the
// world edited, or added, kept with the world and written after the release's
// files at every start.

/** Where the next start takes a file from. */
export type ConfigFileSource = "release" | "world" | "world_only";

export type ConfigFile = Readonly<{
  /** Relative to the world's data folder, inside one of the game's config roots. */
  path: string;
  source: ConfigFileSource;
  bytes: number;
  /** Text within the size limit: the panel can open it. */
  editable: boolean;
  /** The release's version, when the release has one. */
  releaseSha256: string | null;
  /** The world's version, when it edited or added the file. */
  worldSha256: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The release's file is no longer the one the world's edit started from. */
  releaseChanged: boolean;
}>;

export type ConfigFileList = Readonly<{
  /** The release the next start uses; null when the world has none yet. */
  release: string | null;
  roots: readonly string[];
  maxBytes: number;
  files: readonly ConfigFile[];
}>;

export type ConfigFileContent = Readonly<{
  path: string;
  source: ConfigFileSource;
  text: string;
  /** The digest the editor started from; a save names it so a concurrent change is refused. */
  sha256: string;
  releaseSha256: string | null;
}>;

export type SavedConfigFile = Readonly<{ path: string; sha256: string; updatedAt: string }>;
