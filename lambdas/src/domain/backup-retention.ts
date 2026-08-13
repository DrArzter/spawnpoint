export type BackupObject = Readonly<{
  key: string;
  lastModified: string;
}>;

export type RetentionTier = "daily" | "weekly" | "monthly";

export type RetainedBackup = BackupObject & Readonly<{
  tier: RetentionTier;
}>;

export type BackupRetentionPlan = Readonly<{
  keep: readonly RetainedBackup[];
  remove: readonly BackupObject[];
}>;

type Bucket = Readonly<{
  id: string;
  startsAt: number;
}>;

const DAY_MS = 24 * 60 * 60 * 1_000;

function utcDay(timestamp: number): Bucket {
  const date = new Date(timestamp);
  const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return { id: new Date(startsAt).toISOString().slice(0, 10), startsAt };
}

function utcMonth(timestamp: number): Bucket {
  const date = new Date(timestamp);
  const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  return {
    id: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    startsAt,
  };
}

function isoWeek(timestamp: number): Bucket {
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1);
  const thursday = new Date(startsAt + 3 * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return {
    id: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`,
    startsAt,
  };
}

function selectTier(
  candidates: readonly ParsedBackup[],
  limit: number,
  tier: RetentionTier,
  bucketOf: (timestamp: number) => Bucket,
): Readonly<{ selected: RetainedBackup[]; olderThan: number }> {
  const bucketIds = new Set<string>();
  const selected: RetainedBackup[] = [];
  let oldestBucketStart = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const bucket = bucketOf(candidate.timestamp);
    if (bucketIds.has(bucket.id)) continue;

    bucketIds.add(bucket.id);
    selected.push({ key: candidate.key, lastModified: candidate.lastModified, tier });
    oldestBucketStart = Math.min(oldestBucketStart, bucket.startsAt);
    if (selected.length === limit) break;
  }

  return { selected, olderThan: oldestBucketStart };
}

type ParsedBackup = BackupObject & Readonly<{ timestamp: number }>;

export function planBackupRetention(backups: readonly BackupObject[]): BackupRetentionPlan {
  const seenKeys = new Set<string>();
  const parsed = backups.map((backup): ParsedBackup => {
    if (!backup.key || seenKeys.has(backup.key)) {
      throw new Error(`backup keys must be non-empty and unique: ${backup.key}`);
    }
    seenKeys.add(backup.key);

    const timestamp = Date.parse(backup.lastModified);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`invalid lastModified for ${backup.key}: ${backup.lastModified}`);
    }
    return { ...backup, timestamp };
  });

  parsed.sort((left, right) => right.timestamp - left.timestamp || left.key.localeCompare(right.key));

  const daily = selectTier(parsed, 5, "daily", utcDay);
  const weeklyCandidates = parsed.filter((backup) => backup.timestamp < daily.olderThan);
  const weekly = selectTier(weeklyCandidates, 2, "weekly", isoWeek);
  const monthlyCutoff = Number.isFinite(weekly.olderThan) ? weekly.olderThan : daily.olderThan;
  const monthlyCandidates = parsed.filter((backup) => backup.timestamp < monthlyCutoff);
  const monthly = selectTier(monthlyCandidates, 2, "monthly", utcMonth);

  const keep = [...daily.selected, ...weekly.selected, ...monthly.selected];
  const keptKeys = new Set(keep.map((backup) => backup.key));
  const remove = parsed
    .filter((backup) => !keptKeys.has(backup.key))
    .map(({ key, lastModified }) => ({ key, lastModified }));

  return { keep, remove };
}
