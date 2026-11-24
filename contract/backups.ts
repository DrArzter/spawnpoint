// What GET .../backups sends: a world's verified backups, newest first.

/** recorded: written on the archive; ran: the wipe's record of what it ran; origin: the release the wipe began with. */
export type BackupReleaseSource = "recorded" | "ran" | "origin";

export type BackupEntry = Readonly<{
  key: string;
  archiveName: string;
  checksum: string;
  generationId: string | null;
  sizeBytes: number;
  storedAt: string;
  /** The release a restore puts this backup on (ADR-0052); null where it cannot be read. */
  release: string | null;
  releaseSource: BackupReleaseSource | null;
}>;

export type BackupInventory = Readonly<{
  entries: readonly BackupEntry[];
  /** Archives listed but not shown, because their checksum could not be confirmed. */
  unverified: number;
  truncated: boolean;
}>;
