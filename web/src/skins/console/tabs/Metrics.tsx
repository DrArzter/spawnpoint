import { useEffect, useState, type ReactNode } from "react";

import type { HostMetrics, HostMetricSeries, MetricRange } from "../../../api/contract";
import type { MetricsModel } from "../../../core/models";
import { metricScale, seriesLabel, type MetricScale } from "../../../lib/metrics";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Grid } from "../ui/Grid";
import { Segmented } from "../ui/Segmented";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { StatCard, StatSkeleton } from "../ui/StatCard";
import { ChartSkeleton, chartSummary, TimeSeriesChart } from "../ui/TimeSeriesChart";
import { intlLocale, t } from "../../../i18n";

// A5: the charts draw in on the first view of a world's metrics in this session.
const seen = new Set<string>();

const clock = new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short" });

/** A reading's time: the clock within a day, the date as well over a week. */
export function metricTime(range: MetricRange): (at: string) => string {
  return (at) => range === "7d" ? shortDateTime(at) ?? at : clock.format(Date.parse(at));
}

/** A time label under a chart: the clock within a day, the day alone over a week, so three fit a phone. */
export function metricTimeTick(range: MetricRange): (at: string) => string {
  return (at) => (range === "7d" ? day : clock).format(Date.parse(at));
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

const STRIP_LABEL: Readonly<Record<StripState, string>> = { on: t("metrics.hostRunning"), off: t("metrics.noHost"), pending: t("common.notReportedYet") };
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
          label={t("metrics.range")}
          onChange={(range) => { setReveal(true); model.setRange(range); }}
          options={model.ranges.map((range) => ({ value: range.id, label: range.label }))}
          value={model.range}
        />
        {metrics.status === "loading" && <span className="c-metrics-window"><Skeleton text width="15em" /></span>}
        {value && (
          <span className="c-metrics-window" data-tip={t("metrics.roundMinuteReadings", { round: Math.round(value.periodSeconds / 60) })} tabIndex={0 /* NOSONAR focusable tooltip trigger */}>
            {shortDateTime(value.startedAt)} – {shortDateTime(value.endedAt)}
          </span>
        )}
      </div>
      {metrics.status === "loading" && (
        <SkeletonGroup flow>
          <StripCard axis={<><Skeleton text width="6em" /><Skeleton text width="2.5em" /></>} share={<Skeleton text width="3ch" />} track={<div className="c-strip-track"><Skeleton height="100%" /></div>} />
          <Grid kind="stat">{SERIES.map((cell) => <StatSkeleton key={cell} />)}</Grid>
          <Grid kind="metrics">{SERIES.map((cell) => <Card key={cell} loading><ChartSkeleton /></Card>)}</Grid>
        </SkeletonGroup>
      )}
      {metrics.status === "error" && <Card fill label={t("common.metrics")}><LoadError error={metrics.error} kind={metrics.kind} retry={metrics.retry} title={t("metrics.metricsCouldNotLoaded")} verb={t("metrics.readMetrics")} /></Card>}
      {metrics.status === "ready" && value === null && <Card fill label={t("common.metrics")}><Empty icon="monitoring" title={t("metrics.noSessionWindow")} /></Card>}
      {value && <Readings metrics={value} range={rangeLabel} reveal={reveal} />}
    </>
  );
}

function Readings({ metrics, range, reveal }: Readonly<{ metrics: HostMetrics; range: string; reveal: boolean }>) {
  const time = metricTime(metrics.range);
  const timeTick = metricTimeTick(metrics.range);
  const series = metrics.series.map((item) => ({ series: item, label: seriesLabel(item), scale: metricScale(item) }));
  return (
    <>
      <Strip metrics={metrics} range={range} reveal={reveal} />
      <Grid kind="stat" label={t("metrics.latestReadings")}>
        {series.map((item) => <Stat key={item.series.id} label={item.label} scale={item.scale} series={item.series} time={time} />)}
      </Grid>
      <Grid fill kind="metrics">
        {series.map((item) => <Chart key={item.series.id} label={item.label} range={range} reveal={reveal} scale={item.scale} series={item.series} time={time} timeTick={timeTick} />)}
      </Grid>
    </>
  );
}

type SeriesView = Readonly<{ series: HostMetricSeries; label: string; scale: MetricScale; time: (at: string) => string }>;

function Stat({ series, label, scale, time }: SeriesView) {
  const summary = chartSummary(scale.points);
  if (!summary) return <StatCard label={label} value={null} />;
  const latest = scale.points.findIndex((point) => point.at === summary.latestAt);
  const reading = scale.reading(summary.latest, series.points[latest]?.capacity);
  // One reading is a value; a peak and an average need at least two. Memory
  // arrives once per watchdog check, so its first reading stands alone.
  return (
    <StatCard
      detail={summary.count < 2 ? undefined : <><span>{t("metrics.peakAt", { value: scale.text(summary.peak.value), time: time(summary.peak.at) })}</span><span>{t("metrics.average", { value: scale.text(summary.average) })}</span></>}
      label={label}
      tip={scale.share(latest) ?? undefined}
      unit={reading.unit}
      value={reading.value}
    />
  );
}

function Chart({ series, label, scale, range, reveal, time, timeTick }: SeriesView & Readonly<{ range: string; reveal: boolean; timeTick: (at: string) => string }>) {
  const known = scale.points.some((point) => point.value !== null);
  return (
    <Card title={label}>
      {known
        ? <TimeSeriesChart aside={scale.share} ceiling={scale.ceiling} format={scale.text} label={label} pendingFrom={series.pendingFrom} points={scale.points} range={range} reveal={reveal} tick={scale.tick} time={time} timeTick={timeTick} />
        : <Empty icon="monitoring" size="sm" title={t("metrics.hostReportedNothingWindow")} />}
    </Card>
  );
}

/** The Host running card's shell, shared by the strip and its skeleton: the label with its share, the track, the time axis. */
function StripCard({ share, track, axis }: Readonly<{ share: ReactNode; track: ReactNode; axis: ReactNode }>) {
  return (
    <Card label={t("metrics.hostRunning")}>
      <div className="c-strip">
        <span className="c-strip-label">{t("metrics.hostRunning")}<strong>{share}</strong></span>
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
  const end = (run: StripRun) => run.from + run.length >= slots.length ? t("metrics.now") : time(points[run.from + run.length]?.at ?? metrics.endedAt);
  return (
    <StripCard
      axis={<><span>{shortDateTime(metrics.startedAt)}</span><span>{t("metrics.now")}</span></>}
      share={`${share} %`}
      track={(
        <div aria-label={t("metrics.hostRunningShareLast", { share, range })} className={reveal ? "c-strip-track c-strip-reveal" : "c-strip-track"} role="img">
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
