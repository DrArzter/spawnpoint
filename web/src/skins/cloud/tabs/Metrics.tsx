import { useEffect, useState } from "react";

import type { HostMetrics, HostMetricSeries, MetricRange } from "../../../api/contract";
import type { MetricsModel } from "../../../core/models";
import { formatBytes } from "../../../lib/format";
import { Card } from "../ui/Card";
import { shortDateTime } from "../ui/DetailList";
import { Empty, LoadError } from "../ui/Empty";
import { Grid, GridCell } from "../ui/Grid";
import { Segmented } from "../ui/Segmented";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import { StatCard } from "../ui/StatCard";
import { chartSummary, TimeSeriesChart } from "../ui/TimeSeriesChart";

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

/** Whether a host ran at each reading: any series reported a value then. */
export function hostRunning(metrics: HostMetrics): boolean[] {
  const length = Math.max(0, ...metrics.series.map((series) => series.points.length));
  return Array.from({ length }, (_, index) => metrics.series.some((series) => series.points[index]?.value != null));
}

export type StripRun = Readonly<{ on: boolean; from: number; length: number }>;

/** Joins neighbouring readings of one state into runs. */
export function stripRuns(mask: readonly boolean[]): StripRun[] {
  const runs: { on: boolean; from: number; length: number }[] = [];
  mask.forEach((on, index) => {
    const last = runs.at(-1);
    if (last && last.on === on) last.length += 1;
    else runs.push({ on, from: index, length: 1 });
  });
  return runs;
}

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
        {value && (
          <span className="c-metrics-window" data-tip={`${Math.round(value.periodSeconds / 60)}-minute readings`} tabIndex={0}>
            {shortDateTime(value.startedAt)} – {shortDateTime(value.endedAt)}
          </span>
        )}
      </div>
      {metrics.status === "loading" && (
        <SkeletonGroup className="c-metrics-loading">
          <Grid kind="stat">{[0, 1, 2].map((cell) => <Skeleton height={96} key={cell} />)}</Grid>
          <Grid kind="metrics">{[0, 1, 2].map((cell) => <Skeleton height={300} key={cell} />)}</Grid>
        </SkeletonGroup>
      )}
      {metrics.status === "error" && <Card label="Metrics"><LoadError error={metrics.error} kind={metrics.kind} retry={metrics.retry} title="Metrics could not be loaded" verb="read metrics" /></Card>}
      {metrics.status === "ready" && value === null && <Card label="Metrics"><Empty icon="bar_chart" title="No host right now" /></Card>}
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
        {metrics.series.map((series, index) => {
          const chart = <Chart key={series.id} range={range} reveal={reveal} series={series} time={time} />;
          // The first series (CPU) spans two columns from 900px, as the prototype does.
          return index === 0 ? <GridCell key={series.id} span="2">{chart}</GridCell> : chart;
        })}
      </Grid>
    </>
  );
}

function Stat({ series, time }: Readonly<{ series: HostMetricSeries; time: (at: string) => string }>) {
  const format = metricFormat(series.unit);
  const summary = chartSummary(series.points);
  if (!summary || summary.count < 2) return <StatCard label={series.label} value={null} />;
  const [value, ...unit] = format(summary.latest).split(" ");
  return (
    <StatCard
      detail={`Peak ${format(summary.peak.value)} at ${time(summary.peak.at)} · Avg ${format(summary.average)}`}
      label={series.label}
      unit={unit.join(" ")}
      value={value ?? null}
    />
  );
}

function Chart({ series, range, reveal, time }: Readonly<{ series: HostMetricSeries; range: string; reveal: boolean; time: (at: string) => string }>) {
  const known = series.points.some((point) => point.value !== null);
  const gaps = series.points.some((point) => point.value === null);
  const legend = (
    <span className="c-legend">
      <span className="c-legend-item"><span aria-hidden="true" className="c-legend-line" />{series.unit === "percent" ? "%" : "Bytes"}</span>
      {gaps && known && <span className="c-legend-item"><span aria-hidden="true" className="c-legend-gap" />No host</span>}
    </span>
  );
  return (
    <Card actions={legend} title={series.label}>
      {known
        ? <TimeSeriesChart format={metricFormat(series.unit)} label={series.label} percent={series.unit === "percent"} points={series.points} range={range} reveal={reveal} time={time} />
        : <Empty icon="bar_chart" size="sm" title="The host reported nothing in this window." />}
    </Card>
  );
}

/** Host running: when a host reported anything in the window, as one quiet track of runs (§10). */
function Strip({ metrics, range, reveal }: Readonly<{ metrics: HostMetrics; range: string; reveal: boolean }>) {
  const mask = hostRunning(metrics);
  if (mask.length === 0) return null;
  const share = Math.round((mask.filter(Boolean).length / mask.length) * 100);
  const points = metrics.series[0]?.points ?? [];
  const time = metricTime(metrics.range);
  const end = (run: StripRun) => run.from + run.length >= mask.length ? "now" : time(points[run.from + run.length]?.at ?? metrics.endedAt);
  return (
    <Card label="Host running">
      <div className="c-strip">
        <span className="c-strip-label">Host running<strong>{share} %</strong></span>
        <div aria-label={`Host running ${share} % of the last ${range}`} className={reveal ? "c-strip-track c-strip-reveal" : "c-strip-track"} role="img">
          {stripRuns(mask).map((run) => (
            <span
              className={run.on ? "c-strip-run c-strip-on" : "c-strip-run"}
              data-tip={`${run.on ? "Host running" : "No host"} · ${time(points[run.from]?.at ?? metrics.startedAt)}–${end(run)}`}
              key={run.from}
              style={{ flexGrow: run.length }}
            />
          ))}
        </div>
        <div aria-hidden="true" className="c-strip-axis">
          <span>{shortDateTime(metrics.startedAt)}</span>
          <span>Now</span>
        </div>
      </div>
    </Card>
  );
}
