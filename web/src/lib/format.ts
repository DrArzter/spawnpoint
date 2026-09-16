const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function parse(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function formatDateTime(value: string | number | null | undefined, fallback = "Unknown time"): string {
  const parsed = parse(value);
  return parsed ? dateTime.format(parsed) : fallback;
}

export function formatTime(value: string | number | null | undefined, fallback = "Unknown time"): string {
  const parsed = parse(value);
  return parsed ? time.format(parsed) : fallback;
}

export function formatDate(value: string | number | null | undefined, fallback = "Unknown date"): string {
  const parsed = parse(value);
  return parsed ? date.format(parsed) : fallback;
}

const dateNoYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// A timestamp read in a column is two things that must each stay whole: the day
// and the clock. Split here so the view can decide where a line may break, and
// drop the year while it is the current one — `full` keeps what was dropped.
export function formatStamp(value: string | number | null | undefined): Readonly<{ iso: string; date: string; time: string; full: string }> | null {
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
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
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

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
