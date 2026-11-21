import { formatDateTime } from "../../../lib/format";
import { useNow } from "./Flashbar";

/** "just now", "8 min ago", "3 h ago", "2 d ago"; empty when the time is unknown. */
export function relativeTime(at: string | number | null | undefined, now: number): string {
  const time = typeof at === "number" ? at : at ? Date.parse(at) : Number.NaN;
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
