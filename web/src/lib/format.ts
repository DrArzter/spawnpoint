import { intlLocale, t } from "../i18n";
const dateTime = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
const time = new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium" });

/** A time as the API gives it: an ISO string, epoch seconds, or absent. */
export type Instant = string | number | null | undefined;

function parse(value: Instant): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function formatDateTime(value: Instant, fallback = t("ui.unknownTime")): string {
  const parsed = parse(value);
  return parsed ? dateTime.format(parsed) : fallback;
}

export function formatTime(value: Instant, fallback = t("ui.unknownTime")): string {
  const parsed = parse(value);
  return parsed ? time.format(parsed) : fallback;
}

export function formatDate(value: Instant, fallback = t("ui.unknownDate")): string {
  const parsed = parse(value);
  return parsed ? date.format(parsed) : fallback;
}

const dateNoYear = new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric" });

// A timestamp read in a column is two things that must each stay whole: the day
// and the clock. Split here so the view can decide where a line may break, and
// drop the year while it is the current one — `full` keeps what was dropped.
export function formatStamp(value: Instant): Readonly<{ iso: string; date: string; time: string; full: string }> | null {
  const parsed = parse(value);
  if (parsed === null) return null;
  const thisYear = parsed.getFullYear() === new Date().getFullYear();
  return {
    iso: parsed.toISOString(),
    date: thisYear ? dateNoYear.format(parsed) : date.format(parsed),
    time: time.format(parsed),
    full: dateTime.format(parsed),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return t("ui.fixedGiB", { fixed: (bytes / 1024 ** 3).toFixed(2) });
  if (bytes >= 1024 ** 2) return t("ui.fixedMiB", { fixed: (bytes / 1024 ** 2).toFixed(1) });
  if (bytes >= 1024) return t("ui.fixedKiB", { fixed: (bytes / 1024).toFixed(0) });
  return t("ui.bytesB", { bytes });
}

export function shortDigest(value: string, length = 12): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function shortCommit(value: string): string {
  return value.slice(0, 7);
}

// A preset is identified by a repository and the commit that was built, and the
// commit is the half worth following: the repository root shows whatever is
// there today, which is not what this build came from.
export function commitUrl(repository: string, commit: string): string {
  const base = repository.replace(/\.git$/, "").replace(/\/$/, "");
  return /^https?:\/\/(www\.)?github\.com\//.test(base) ? `${base}/commit/${commit}` : base;
}

export function repositoryName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/** How long since `since`: h:mm:ss under a day, "2 d 5 h" past it; null when the start is unknown. */
export function formatUptime(since: string | null | undefined, now: number): string | null {
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return t("ui.floorDValueH", { floor: Math.floor(hours / 24), value: hours % 24 });
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
