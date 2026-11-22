import { useEffect, useState, type ReactNode } from "react";

import type { HostMetrics, HostMetricSeries, MetricRange } from "../../../api/contract";
import type { MetricsModel } from "../../../core/models";
import { formatBytes } from "../../../lib/format";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { Segmented } from "../ui/Segmented";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { StatCard, StatSkeleton } from "../ui/StatCard";
import { ChartSkeleton, chartNotes, chartSummary, TimeSeriesChart } from "../ui/TimeSeriesChart";

// A5: the charts draw in on the first view of a world's metrics in this session.
const seen = new Set<string>();

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A reading's value in its series' unit: a percentage, else bytes. */
export function metricFormat(unit: string): (value: number) => string {
  return unit === "percent" ? (value) => `${Number(value.toFixed(1))} %` : formatBytes;
}

/** A reading's time: the clock within a day, the date as well over a week. */
export function metricTime(range: MetricRange): (at: string) => string {
  return (at) => range === "7d" ? shortDateTime(at) ?? at : clock.format(Date.parse(at));
}

/**
 * Whether a host ran at each reading: any series reported a value then. Memory
 * is left out: the watchdog publishes it, not EC2, so its readings do not line
 * up with the host's own and say nothing about when the host ran.
 */
export function hostRunning(metrics: HostMetrics): boolean[] {
  const series = metrics.series.filter((item) => item.id !== "memory");
  const length = Math.max(0, ...series.map((item) => item.points.length));
  return Array.from({ length }, (_, index) => series.some((item) => item.points[index]?.value != null));
}

/** A slot of the Host running strip: the host reported, it did not, or its readings are not due yet. */
export type StripState = "on" | "off" | "pending";

/** Each reading's state. An empty slot from `pendingFrom` on is pending, not off. */
export function hostSlots(metrics: HostMetrics): StripState[] {
  const running = hostRunning(metrics);
  const first = metrics.pendingFrom === undefined ? -1 : (metrics.series[0]?.points ?? []).findIndex((point) => point.at >= metrics.pendingFrom!);
  return running.map((on, index): StripState => {
    if (on) return "on";
    return first >= 0 && index >= first ? "pending" : "off";
  });
}

export type StripRun = Readonly<{ state: StripState; from: number; length: number }>;

/** Joins neighbouring readings of one state into runs. */
export function stripRuns(states: readonly StripState[]): StripRun[] {
  const runs: { state: StripState; from: number; length: number }[] = [];
  states.forEach((state, index) => {
    const last = runs.at(-1);
    if (last?.state === state) last.length += 1;
    else runs.push({ state, from: index, length: 1 });
  });
  return runs;
}

const STRIP_LABEL: Readonly<Record<StripState, string>> = { on: "Host running", off: "No host", pending: "Not reported yet" };
const STRIP_CLASS: Readonly<Record<StripState, string>> = { on: "c-strip-run c-strip-on", off: "c-strip-run", pending: "c-strip-run c-strip-pending" };

// A host reports four series (CPU, memory and the two networks); the skeleton draws that many.
const SERIES = [0, 1, 2, 3];

export function MetricsTab({ model, worldId }: Readonly<{ model: MetricsModel; worldId: string }>) {
  const [reveal, setReveal] = useState(() => !seen.has(worldId));
  useEffect(() => { seen.add(worldId); }, [worldId]);
  const rangeLabel = model.ranges.find((range) => range.id === model.range)?.label ?? model.range;
  const metrics = model.metrics;
  const value = metrics.status === "ready" ? metrics.value : null;
  return (
    <>
      <div className="c-metrics-bar">
        <Segmented
          label="Range"
          onChange={(range) => { setReveal(true); model.setRange(range); }}
          options={model.ranges.map((range) => ({ value: range.id, label: range.label }))}
          value={model.range}
        />
        {metrics.status === "loading" && <span className="c-metrics-window"><Skeleton text width="15em" /></span>}
        {value && (
          <span className="c-metrics-window" data-tip={`${Math.round(value.periodSeconds / 60)}-minute readings`} tabIndex={0 /* NOSONAR focusable tooltip trigger */}>
            {shortDateTime(value.startedAt)} – {shortDateTime(value.endedAt)}
          </span>
        )}
      </div>
      {metrics.status === "loading" && (
        <SkeletonGroup className="c-metrics-loading">
          <StripCard axis={<><Skeleton text width="6em" /><Skeleton text width="2.5em" /></>} share={<Skeleton text width="3ch" />} track={<div className="c-strip-track"><Skeleton height="100%" /></div>} />
          <Grid kind="stat">{SERIES.map((cell) => <StatSkeleton key={cell} />)}</Grid>
          <Grid kind="metrics">{SERIES.map((cell) => <Card key={cell} loading><ChartSkeleton /></Card>)}</Grid>
        </SkeletonGroup>
      )}
      {metrics.status === "error" && <Card label="Metrics"><LoadError error={metrics.error} kind={metrics.kind} retry={metrics.retry} title="Metrics could not be loaded" verb="read metrics" /></Card>}
      {metrics.status === "ready" && value === null && <Card label="Metrics"><Empty icon="monitoring" title="No session in this window" /></Card>}
      {value && <Readings metrics={value} range={rangeLabel} reveal={reveal} />}
    </>
  );
}

function Readings({ metrics, range, reveal }: Readonly<{ metrics: HostMetrics; range: string; reveal: boolean }>) {
  const time = metricTime(metrics.range);
  return (
    <>
      <Strip metrics={metrics} range={range} reveal={reveal} />
      <Grid kind="stat" label="Latest readings">
        {metrics.series.map((series) => <Stat key={series.id} series={series} time={time} />)}
      </Grid>
      <Grid kind="metrics">
        {metrics.series.map((series) => <Chart key={series.id} range={range} reveal={reveal} series={series} time={time} />)}
      </Grid>
    </>
  );
}

function Stat({ series, time }: Readonly<{ series: HostMetricSeries; time: (at: string) => string }>) {
  const format = metricFormat(series.unit);
  const summary = chartSummary(series.points);
  if (!summary) return <StatCard label={series.label} value={null} />;
  const [value, ...unit] = format(summary.latest).split(" ");
  // One reading is a value; a peak and an average need at least two. Memory
  // arrives once per watchdog check, so its first reading stands alone.
  return (
    <StatCard
      detail={summary.count < 2 ? undefined : <><span>Peak {format(summary.peak.value)} at {time(summary.peak.at)}</span><span>Avg {format(summary.average)}</span></>}
      label={series.label}
      unit={unit.join(" ")}
      value={value ?? null}
    />
  );
}

function Chart({ series, range, reveal, time }: Readonly<{ series: HostMetricSeries; range: string; reveal: boolean; time: (at: string) => string }>) {
  const known = series.points.some((point) => point.value !== null);
  const notes = chartNotes(series.points, series.pendingFrom);
  const legend = (
    <span className="c-legend">
      <span className="c-legend-item"><span aria-hidden="true" className="c-legend-line" />{series.unit === "percent" ? "%" : "Bytes"}</span>
      {notes.gaps && known && <span className="c-legend-item"><span aria-hidden="true" className="c-legend-gap" />No host</span>}
      {notes.pending && <span className="c-legend-item"><span aria-hidden="true" className="c-legend-pending" />Not reported yet</span>}
    </span>
  );
  return (
    <Card actions={known ? legend : undefined} title={series.label}>
      {known
        ? <TimeSeriesChart format={metricFormat(series.unit)} label={series.label} pendingFrom={series.pendingFrom} percent={series.unit === "percent"} points={series.points} range={range} reveal={reveal} time={time} />
        : <Empty icon="monitoring" size="sm" title="The host reported nothing in this window." />}
    </Card>
  );
}

/** The Host running card's shell, shared by the strip and its skeleton: the label with its share, the track, the time axis. */
function StripCard({ share, track, axis }: Readonly<{ share: ReactNode; track: ReactNode; axis: ReactNode }>) {
  return (
    <Card label="Host running">
      <div className="c-strip">
        <span className="c-strip-label">Host running<strong>{share}</strong></span>
        {track}
        <div aria-hidden="true" className="c-strip-axis">{axis}</div>
      </div>
    </Card>
  );
}

/** Host running: when a host reported anything in the window, as one quiet track of runs (§10). */
function Strip({ metrics, range, reveal }: Readonly<{ metrics: HostMetrics; range: string; reveal: boolean }>) {
  const slots = hostSlots(metrics);
  if (slots.length === 0) return null;
  // Slots not due yet say nothing about the host, so they stay out of the share.
  const due = slots.filter((state) => state !== "pending");
  const share = due.length === 0 ? 0 : Math.round((due.filter((state) => state === "on").length / due.length) * 100);
  const points = metrics.series[0]?.points ?? [];
  const time = metricTime(metrics.range);
  const end = (run: StripRun) => run.from + run.length >= slots.length ? "now" : time(points[run.from + run.length]?.at ?? metrics.endedAt);
  return (
    <StripCard
      axis={<><span>{shortDateTime(metrics.startedAt)}</span><span>Now</span></>}
      share={`${share} %`}
      track={(
        <div aria-label={`Host running ${share} % of the last ${range}`} className={reveal ? "c-strip-track c-strip-reveal" : "c-strip-track"} role="img">
          {stripRuns(slots).map((run) => (
            <span
              className={STRIP_CLASS[run.state]}
              data-tip={`${STRIP_LABEL[run.state]} · ${time(points[run.from]?.at ?? metrics.startedAt)}–${end(run)}`}
              key={run.from}
              style={{ flexGrow: run.length }}
            />
          ))}
        </div>
      )}
    />
  );
}
