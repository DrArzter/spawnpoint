import type { SessionHost } from "../domain/session-history.ts";
import type { HostMetricPoint, HostMetrics, HostMetricSeries } from "./read-model.ts";

/*
 * A world's metrics across the hosts it used (ADR-0015). Every host is read
 * on one grid of periods. Each slot then takes the reading of the host that ran
 * the world in that slot. Readings of two hosts are never added or averaged:
 * when two runs share a slot, the run that covers more of it and has a reading
 * wins, and a later start wins a tie.
 */

/** One stretch of a world on one host. A null end is a session that runs now. */
export type HostRun = Readonly<{ hostId: string; startedAtMs: number; endedAtMs: number | null }>;

/**
 * The idle watchdog probes every 15 minutes (`checkIntervalSeconds`, ADR-0015),
 * and memory is only read by that probe.
 */
export const MEMORY_PROBE_SECONDS = 900;
// A late probe still joins. More than this apart, the readings are two
// observations with an unknown stretch between them.
const MEMORY_JOIN_MARGIN_SECONDS = 300;
const SAMPLED_SERIES = "memory";
const HOST_ACTIVITY = "cpu";

export type LiveSession = Readonly<{ hostId: string; sessionId: string | null; startedAtMs: number }>;

/**
 * The runs of a world inside a window. A stored entry that is still open is the
 * live session when it is the live one; otherwise its stop was not seen, and it
 * ends when the world's record last changed (never before it began).
 */
export function worldHostRuns(
  entries: readonly SessionHost[],
  live: LiveSession | null,
  options: Readonly<{ windowStartMs: number; nowMs: number; unseenStopMs: number | null }>,
): HostRun[] {
  const runs: HostRun[] = [];
  for (const entry of entries) {
    const startedAtMs = Date.parse(entry.startedAt);
    const isLive = live !== null && entry.endedAt === null && entry.sessionId === live.sessionId;
    if (isLive) continue;
    const endedAtMs = entry.endedAt !== null
      ? Date.parse(entry.endedAt)
      : Math.min(options.nowMs, Math.max(startedAtMs, options.unseenStopMs ?? startedAtMs));
    if (endedAtMs > options.windowStartMs) runs.push({ hostId: entry.hostId, startedAtMs, endedAtMs });
  }
  if (live !== null) {
    const stored = entries.find((entry) => entry.sessionId === live.sessionId);
    runs.push({ hostId: live.hostId, startedAtMs: stored ? Date.parse(stored.startedAt) : live.startedAtMs, endedAtMs: null });
  }
  return runs.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

export function hostIdsOf(runs: readonly HostRun[]): string[] {
  return [...new Set(runs.map((run) => run.hostId))];
}

type Owned = Readonly<{ point: HostMetricPoint; hostId: string | null }>;

function overlapMs(run: HostRun, slotStart: number, slotEnd: number): number {
  return Math.min(run.endedAtMs ?? Infinity, slotEnd) - Math.max(run.startedAtMs, slotStart);
}

function ownedSeries(
  id: string,
  perHost: Readonly<Record<string, HostMetrics>>,
  runs: readonly HostRun[],
  slots: readonly string[],
  periodMs: number,
): Owned[] {
  const valueOf = (hostId: string, index: number): number | null =>
    perHost[hostId]?.series.find((series) => series.id === id)?.points[index]?.value ?? null;
  return slots.map((at, index) => {
    const slotStart = Date.parse(at);
    const candidates = runs
      .map((run) => ({ run, overlap: overlapMs(run, slotStart, slotStart + periodMs) }))
      .filter(({ run, overlap }) => overlap > 0 && valueOf(run.hostId, index) !== null)
      .sort((a, b) => b.overlap - a.overlap || b.run.startedAtMs - a.run.startedAtMs);
    const chosen = candidates[0]?.run;
    return chosen === undefined
      ? { point: { at, value: null }, hostId: null }
      : { point: { at, value: valueOf(chosen.hostId, index) }, hostId: chosen.hostId };
  });
}

/**
 * The one place a gap is joined. Memory is read by a probe every 15 minutes, so
 * on a 5-minute grid two of every three slots are empty although the host ran.
 * Two memory readings are joined with a straight line when they are one probe
 * (plus a margin) apart or closer, come from one host, and the host reported
 * CPU in every slot between. CPU and network are never joined: for them an
 * empty slot is a real gap.
 */
export function joinSampledSeries(
  owned: readonly Owned[],
  activity: readonly Owned[],
  periodSeconds: number,
  probeSeconds: number = MEMORY_PROBE_SECONDS,
): HostMetricPoint[] {
  const points: HostMetricPoint[] = owned.map(({ point }) => point);
  const maxGapSlots = Math.floor((probeSeconds + MEMORY_JOIN_MARGIN_SECONDS) / periodSeconds);
  let previous = -1;
  owned.forEach((entry, index) => {
    if (entry.point.value === null) return;
    const before = owned[previous];
    const span = index - previous;
    const joinable = previous >= 0 && span > 1 && span <= maxGapSlots && before?.hostId === entry.hostId &&
      activity.slice(previous + 1, index).every((slot) => slot.point.value !== null);
    if (joinable && before?.point.value != null) {
      for (let slot = previous + 1; slot < index; slot += 1) {
        const share = (slot - previous) / span;
        points[slot] = { at: owned[slot]!.point.at, value: Math.round((before.point.value + (entry.point.value - before.point.value) * share) * 100) / 100, interpolated: true };
      }
    }
    previous = index;
  });
  return points;
}

// Basic monitoring reports a few minutes late. Older than this, an empty slot is
// a real gap again, even while the session runs.
const MAX_PENDING_SECONDS = 1800;

/**
 * Where "not reported yet" starts inside a live run: the slot after the last
 * reading, or the run's first slot. Only the newest slots can be pending.
 */
function pendingSlot(points: readonly HostMetricPoint[], liveRun: HostRun | undefined, periodSeconds: number): string | undefined {
  if (liveRun === undefined) return undefined;
  const periodMs = periodSeconds * 1000;
  const firstInRun = points.findIndex((point) => Date.parse(point.at) + periodMs > liveRun.startedAtMs);
  if (firstInRun < 0) return undefined;
  let last = -1;
  points.forEach((point, index) => { if (index >= firstInRun && point.value !== null && point.interpolated !== true) last = index; });
  const oldest = Math.max(0, points.length - Math.max(1, Math.ceil(MAX_PENDING_SECONDS / periodSeconds)));
  return points[Math.max(last < 0 ? firstInRun : last + 1, oldest)]?.at;
}

/**
 * Merges the hosts' readings onto the first host's grid. `liveRun` is the
 * running session's run; while there is one, the slots the newest readings have
 * not reached are marked pending (EC2 basic monitoring reports minutes late).
 */
export function mergeWorldMetrics(perHost: Readonly<Record<string, HostMetrics>>, runs: readonly HostRun[]): HostMetrics | null {
  const template = Object.values(perHost)[0];
  const firstSeries = template?.series[0];
  if (template === undefined || firstSeries === undefined) return null;
  const slots = firstSeries.points.map((point) => point.at);
  const periodMs = template.periodSeconds * 1000;
  const liveRun = runs.find((run) => run.endedAtMs === null);
  const owned = new Map(template.series.map((series) => [series.id, ownedSeries(series.id, perHost, runs, slots, periodMs)]));
  const merged: HostMetricSeries[] = template.series.map((series) => {
    const own = owned.get(series.id)!;
    const points = series.id === SAMPLED_SERIES
      ? joinSampledSeries(own, owned.get(HOST_ACTIVITY) ?? [], template.periodSeconds)
      : own.map(({ point }) => point);
    const pendingFrom = pendingSlot(points, liveRun, template.periodSeconds);
    return { id: series.id, label: series.label, unit: series.unit, points, ...(pendingFrom ? { pendingFrom } : {}) };
  });
  const pendingFrom = merged.find((series) => series.id === HOST_ACTIVITY)?.pendingFrom;
  return { startedAt: template.startedAt, endedAt: template.endedAt, periodSeconds: template.periodSeconds, series: merged, ...(pendingFrom ? { pendingFrom } : {}) };
}
