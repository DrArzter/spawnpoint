import { formatDateTime } from "../../../lib/format";
import { useNow } from "./Flashbar";

/** Milliseconds since the epoch for a time given as milliseconds or an ISO string; NaN when unknown. */
export function instantMs(at: string | number | null | undefined): number {
  if (typeof at === "number") return at;
  return at ? Date.parse(at) : Number.NaN;
}

/** "just now", "8 min ago", "3 h ago", "2 d ago"; empty when the time is unknown. */
export function relativeTime(at: string | number | null | undefined, now: number): string {
  const time = instantMs(at);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A relative time that changes its text once a clock tick, with the full time as its tooltip. */
export function Ago({ at, prefix }: Readonly<{ at: string | number | null | undefined; prefix?: string }>) {
  const now = useNow(at !== null && at !== undefined);
  const text = relativeTime(at, now);
  if (!text) return <span className="c-faint">—</span>;
  const iso = new Date(typeof at === "number" ? at : Date.parse(at as string)).toISOString();
  return <time data-tip={formatDateTime(at)} dateTime={iso}>{prefix ? `${prefix} ${text}` : text}</time>;
}
