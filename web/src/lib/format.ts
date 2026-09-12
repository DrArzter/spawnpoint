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

export function repositoryName(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
