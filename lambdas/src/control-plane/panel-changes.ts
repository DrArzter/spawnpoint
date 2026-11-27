/*
 * Which table writes make an open panel read its snapshot again (ADR-0104).
 * The tables report their own changes; this decides which of them the panel
 * shows. The stream's filter already drops most of the rest; this is the part
 * a filter cannot do, comparing the old item with the new one.
 */

/** One item change, read from a table's change stream by an adapter. */
export type TableChange = Readonly<{
  table: string;
  kind: "insert" | "modify" | "remove";
  keys: Readonly<Record<string, unknown>>;
  oldImage: Readonly<Record<string, unknown>> | null;
  newImage: Readonly<Record<string, unknown>> | null;
  atEpochMilliseconds: number | null;
}>;

export type StreamedTables = Readonly<{ lifecycle: string; view: string }>;

/** What to reload: the dashboard projection, or one session record by its key (a game id or `world#<id>`). */
export type PanelReloads = Readonly<{ targets: readonly string[]; observedAtEpochMilliseconds: number | null }>;

export const PROJECTION_TARGET = "projection";
const PROJECTION_KEY = { pk: "PROJECTION#CONTROL_PLANE", sk: "DYNAMIC" } as const;

// The record fields the panel draws. A lease, a fencing token, a player count
// or an updated-at time changes none of them.
const SHOWN_LIFECYCLE_FIELDS = ["observedState", "desiredState", "activeSessionId", "activeWorldId", "activeSessionAddress"] as const;

function lifecycleOf(image: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
  const value = image?.lifecycle;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function lifecycleTarget(change: TableChange): string | null {
  const serverId = change.keys.server_id;
  if (typeof serverId !== "string" || serverId === "") return null;
  const before = lifecycleOf(change.oldImage);
  const after = lifecycleOf(change.newImage);
  if (before === null && after === null) return null;
  if (before === null || after === null) return serverId;
  return SHOWN_LIFECYCLE_FIELDS.some((field) => (before[field] ?? null) !== (after[field] ?? null)) ? serverId : null;
}

function viewTarget(change: TableChange): string | null {
  return change.keys.pk === PROJECTION_KEY.pk && change.keys.sk === PROJECTION_KEY.sk ? PROJECTION_TARGET : null;
}

function reloadTarget(change: TableChange, tables: StreamedTables): string | null {
  if (change.table === tables.lifecycle) return lifecycleTarget(change);
  if (change.table === tables.view) return viewTarget(change);
  return null;
}

/** The distinct reloads one batch of changes asks for, and the time of its latest change. */
export function panelReloads(changes: readonly TableChange[], tables: StreamedTables): PanelReloads {
  const targets = new Set<string>();
  let observedAt: number | null = null;
  for (const change of changes) {
    const target = reloadTarget(change, tables);
    if (target === null) continue;
    targets.add(target);
    if (change.atEpochMilliseconds !== null && (observedAt === null || change.atEpochMilliseconds > observedAt)) {
      observedAt = change.atEpochMilliseconds;
    }
  }
  return { targets: [...targets].sort((a, b) => a.localeCompare(b)), observedAtEpochMilliseconds: observedAt };
}
