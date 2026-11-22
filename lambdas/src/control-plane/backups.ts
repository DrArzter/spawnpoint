// The backup inventory a panel may show.
//
// Two properties make this readable without ever downloading a world: the key
// is checksum-addressed by upload-world-backup.sh, so the digest is in the name,
// and S3 reports each object's checksum algorithm in a listing. So "verified"
// here means what it can honestly mean from a listing — the digest in the key
// is well formed and S3 holds a SHA-256 checksum for the object — and anything
// that fails those is reported as unverified rather than hidden, because a
// silently shortened list is how corruption stays invisible.

export type BackupObject = Readonly<{
  key: string;
  sizeBytes: number;
  storedAt: string;
  checksumAlgorithms: readonly string[];
}>;

export type BackupEntry = Readonly<{
  key: string;
  archiveName: string;
  checksum: string;
  generationId: string | null;
  sizeBytes: number;
  storedAt: string;
}>;

export type BackupInventory = Readonly<{
  entries: readonly BackupEntry[];
  unverified: number;
  truncated: boolean;
}>;

const CHECKSUM_ADDRESSED = /^(?<name>[A-Za-z0-9._-]+)-(?<checksum>[0-9a-f]{64})\.tar\.zst$/;
const GENERATION_IN_ARCHIVE = /-(gen-[0-9a-f]{32})-\d{8}T\d{6}Z\.tar\.zst$/;

export function backupInventory(objects: readonly BackupObject[], limit = 20): BackupInventory {
  const newestFirst = [...objects].sort((left, right) => right.storedAt.localeCompare(left.storedAt));

  const entries: BackupEntry[] = [];
  let unverified = 0;
  for (const object of newestFirst) {
    const name = object.key.slice(object.key.lastIndexOf("/") + 1);
    const match = CHECKSUM_ADDRESSED.exec(name);
    const hasChecksum = object.checksumAlgorithms.includes("SHA256");
    if (match?.groups === undefined || !hasChecksum) {
      unverified += 1;
      continue;
    }
    const { name: archiveBase, checksum } = match.groups;
    if (archiveBase === undefined || checksum === undefined) {
      unverified += 1;
      continue;
    }
    if (entries.length >= limit) continue;
    entries.push({
      key: object.key,
      archiveName: `${archiveBase}.tar.zst`,
      checksum,
      generationId: GENERATION_IN_ARCHIVE.exec(`${archiveBase}.tar.zst`)?.[1] ?? null,
      sizeBytes: object.sizeBytes,
      storedAt: object.storedAt,
    });
  }

  return { entries, unverified, truncated: newestFirst.length - unverified > entries.length };
}

const RESUMABLE = /-\d{8}T\d{6}Z-[0-9a-f]{64}\.tar\.zst$/;

// Keys sort by code unit, as jq's sort in prepare-world.sh picks the newest.
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The archive a wipe's next start resumes from: its greatest timestamped key, as server/scripts/prepare-world.sh picks it. */
export function resumeArchiveKey(worldId: string, generationId: string, keys: readonly string[]): string | undefined {
  const prefix = `worlds/${worldId}/archives/${worldId}-${generationId}-`;
  return keys.filter((key) => key.startsWith(prefix) && RESUMABLE.test(key)).sort(byCodeUnit).at(-1);
}
