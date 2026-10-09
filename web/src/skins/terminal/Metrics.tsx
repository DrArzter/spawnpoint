import type { ReactNode } from "react";

import type { HostMetricPoint, HostMetrics } from "../../api/contract";
import { Timestamp } from "../../components/ui/Timestamp";
import type { MetricsModel } from "../../core/models";
import { formatBytes } from "../../lib/format";
import { Choice, Choices, Empty, Notice, Panel, Skeleton, SkeletonGroup, Verb } from "./ui";

// Metrics the way the status page draws its response line: one series is one
// well with the area under its line filled in the accent, no axes and no
// grid, a caption under it with the one number worth reading, and the window
// stated once for all of them. A gap in the readings is a gap in the line,
// not a line drawn to zero.
const WIDTH = 480;
const HEIGHT = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 12;

const formatMetric = (unit: string) => (value: number) => (unit === "percent" ? `${value.toFixed(1)}%` : formatBytes(value));

// One world's host, measured (ADR-0062): never the first host in a list.
export function MetricsPanel({ model }: Readonly<{ model: MetricsModel }>) {
  const metrics = model.metrics;
  if (metrics.status === "error" && metrics.kind === "unavailable") {
    return <Panel><Empty title="CloudWatch is not connected yet" /></Panel>;
  }
  if (metrics.status === "ready" && metrics.value === null) {
    return <Panel><Empty description="Metrics show the host this world's session runs on. Start the world to see them." title="No host right now" /></Panel>;
  }
  return (
    <Panel
      head={<Choices label="Window">
        {model.ranges.map((option) => <Choice key={option.id} onClick={() => model.setRange(option.id)} pressed={model.range === option.id}>{option.label}</Choice>)}
      </Choices>}
      name="Host this world runs on"
    >
      {metrics.status === "error" && <Notice description={metrics.error} title="Metrics could not be loaded" tone="error" verbs={<Verb action={metrics.retry} size="small" />} />}
      {metrics.status === "loading" && waiting}
      {metrics.status === "ready" && metrics.value !== null && lineCharts(metrics.value)}
    </Panel>
  );
}

// The labels and final chart geometry are already useful while the readings
// arrive. One group announces the wait; the three plots do not repeat it.
const waitingSeries = [
  { id: "cpu", label: "CPU" },
  { id: "in", label: "Network in" },
  { id: "out", label: "Network out" },
] as const;

const waiting: ReactNode = (
  <SkeletonGroup label="Reading CloudWatch metrics">
    {waitingSeries.map((series) => (
      <div className="t-chart" key={series.id}>
        <Skeleton className="t-chart-well" variant="plot" />
        <p className="t-chart-caption">
          <strong>{series.label}</strong>
          <Skeleton width="short" />
        </p>
      </div>
    ))}
    <div className="t-chart-scale">
      <Skeleton width="medium" />
      <Skeleton width="medium" />
    </div>
  </SkeletonGroup>
);

export function seriesPeak(points: readonly Readonly<{ value: number | null }>[]): number | null {
  const known = points.filter((point) => point.value !== null);
  return known.length > 0 ? Math.max(...known.map((point) => point.value ?? 0)) : null;
}

function lineCharts(metrics: HostMetrics): ReactNode {
  return (
    <>
      {metrics.series.map((series) => {
        const peak = seriesPeak(series.points);
        const format = formatMetric(series.unit);
        const runs = tracePaths(series.points, peak);
        return (
          <section className="t-chart" key={series.id}>
            <svg aria-label={`${series.label} over the window`} className="t-chart-well" preserveAspectRatio="none" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
              {runs.map((run) => <polygon className="t-chart-area" key={`area-${run.from}`} points={run.area} />)}
              {runs.map((run) => <polyline className="t-chart-line" key={`line-${run.from}`} points={run.line} />)}
            </svg>
            <p className="t-chart-caption">
              <strong>{series.label}</strong>
              <span>{peak === null ? "no data in this window" : <>peak <strong>{format(peak)}</strong></>}</span>
            </p>
          </section>
        );
      })}
      <div className="t-chart-scale">
        <Timestamp value={metrics.startedAt} />
        <Timestamp value={metrics.endedAt} />
      </div>
    </>
  );
}

type Run = Readonly<{ from: number; line: string; area: string }>;

// Every point keeps its place in the window, so a series that starts a third
// of the way in starts a third of the way in. Consecutive known points form a
// run; each run is its own line and its own area.
export function tracePaths(points: readonly HostMetricPoint[], peak: number | null): Run[] {
  if (peak === null || peak <= 0 || points.length < 2) return [];
  const step = WIDTH / (points.length - 1);
  const x = (index: number) => (index * step).toFixed(2);
  const y = (value: number) => (HEIGHT - PAD_BOTTOM - (value / peak) * (HEIGHT - PAD_TOP - PAD_BOTTOM)).toFixed(2);
  const runs: Run[] = [];
  let current: Array<readonly [number, number]> = [];
  const close = () => {
    if (current.length >= 2) {
      const line = current.map(([i, value]) => `${x(i)},${y(value)}`).join(" ");
      const first = current[0]?.[0] ?? 0;
      const last = current.at(-1)?.[0] ?? 0;
      runs.push({ from: first, line, area: `${x(first)},${HEIGHT} ${line} ${x(last)},${HEIGHT}` });
    }
    current = [];
  };
  points.forEach((point, index) => {
    if (point.value === null) close();
    else current.push([index, point.value]);
  });
  close();
  return runs;
}
