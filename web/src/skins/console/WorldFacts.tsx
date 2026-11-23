import type { WorldRow } from "../../core/models";
import type { StatusDescriptor, StatusKind } from "../../core/status";
import { Icon } from "../../icons";
import { Chip } from "./ui/Chip";
import { useNow } from "./ui/Flashbar";
import { Indicator } from "./ui/Indicator";
import { formatUptime } from "../../lib/format";

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

/** A ticking uptime, "—" when the launch time is unknown. */
export function Uptime({ since }: Readonly<{ since: string | null | undefined }>) {
  const now = useNow(Boolean(since));
  const text = formatUptime(since, now);
  return text === null ? <span className="c-faint">—</span> : <span className="c-mono">{text}</span>;
}

/** Players online, "—" when unknown. */
export function Players({ count }: Readonly<{ count: number | null | undefined }>) {
  if (count === null || count === undefined) return <span className="c-faint">—</span>;
  return <span className="c-players"><Icon name="person" size={16} /><span>{count}</span></span>;
}
