import type { WorldRow } from "../../core/models";
import type { StatusDescriptor, StatusKind } from "../../core/status";
import { Icon } from "../../icons";
import { Chip } from "./ui/Chip";
import { useNow } from "./ui/Flashbar";
import { Indicator } from "./ui/Indicator";

/*
 * Facts about a world that the game home, the Worlds list and the quick
 * look draw the same way. They are page vocabulary built on the primitives,
 * not primitives themselves.
 */

// The order states read in tiles, the state bar and a status sort (spec §6.1).
const ORDER: readonly StatusKind[] = ["ok", "ready", "progress", "pending", "info", "unknown", "warning", "error", "off", "archived", "absent"];

export function statusRank(status: StatusDescriptor): number {
  return ORDER.indexOf(status.kind);
}

/** The distinct states of some rows, by label, in reading order, with how many rows hold each. */
export function statesOf(rows: readonly WorldRow[]): readonly Readonly<{ status: StatusDescriptor; count: number }>[] {
  const counts = new Map<string, { status: StatusDescriptor; count: number }>();
  for (const row of rows) {
    const known = counts.get(row.status.label);
    if (known) known.count += 1;
    else counts.set(row.status.label, { status: row.status, count: 1 });
  }
  return [...counts.values()].sort((a, b) => statusRank(a.status) - statusRank(b.status));
}

export function hostingLabel(row: WorldRow): string {
  return row.world.placement === "fleet" ? "Fleet" : "Persistent";
}

const hostingIcon = (row: WorldRow) => row.world.placement === "fleet" ? "bolt" : "dns";

export function HostingChip({ row }: Readonly<{ row: WorldRow }>) {
  return <Chip icon={hostingIcon(row)}>{hostingLabel(row)}</Chip>;
}

/** The hosting as an icon alone, its word in the tooltip; it follows a name where the Hosting column drops. */
export function HostingMark({ row, className }: Readonly<{ row: WorldRow; className?: string }>) {
  return <Indicator className={className} icon={hostingIcon(row)} label={hostingLabel(row)} />;
}

/** "Release 1.2 · wipe #3"; the absent wipe as core words it. */
export function releaseLine(row: WorldRow): string {
  const wipe = row.wipe ? `#${row.wipe.number}` : row.wipeAbsent;
  return `${row.releaseSummary} · ${wipe}`;
}

/** How long since `since`: h:mm:ss under a day, "2 d 5 h" past it. */
export function uptimeText(since: string | null | undefined, now: number): string | null {
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A ticking uptime, "—" when the launch time is unknown. */
export function Uptime({ since }: Readonly<{ since: string | null | undefined }>) {
  const now = useNow(Boolean(since));
  const text = uptimeText(since, now);
  return text === null ? <span className="c-faint">—</span> : <span className="c-mono">{text}</span>;
}

/** Players online, "—" when unknown. */
export function Players({ count }: Readonly<{ count: number | null | undefined }>) {
  if (count === null || count === undefined) return <span className="c-faint">—</span>;
  return <span className="c-players"><Icon name="person" size={16} /><span>{count}</span></span>;
}
