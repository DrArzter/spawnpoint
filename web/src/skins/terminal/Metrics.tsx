import type { ReactNode } from "react";

import type { HostMetrics } from "../../api/contract";
import { Timestamp } from "../../components/ui/Timestamp";
import type { MetricsModel } from "../../core/models";
import { metricScale, seriesLabel } from "../../lib/metrics";
import { Choice, Choices, Empty, LoadError, Panel, Skeleton, SkeletonGroup } from "./ui";
import { rich, t } from "../../i18n";

// Metrics the way the status page draws its response line: one series is one
// well with the area under its line filled in the accent, no axes and no
// grid, a caption under it with the one number worth reading, and the window
// stated once for all of them. A gap in the readings is a gap in the line,
// not a line drawn to zero.
const WIDTH = 480;
const HEIGHT = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 12;

// One world's hosts, measured (ADR-0062): never the first host in a list. The
// server joins the hosts of its sessions, and joins memory readings between
// probes (flagged), so a line is a line here; the rest of the window is blank.
export function MetricsPanel({ model }: Readonly<{ model: MetricsModel }>) {
  const metrics = model.metrics;
  if (metrics.status === "ready" && metrics.value === null) {
    return <Panel><Empty description={t("metrics.metricsShowHostsWorlds")} title={t("metrics.noSessionWindow")} /></Panel>;
  }
  return (
    <Panel
      head={<Choices label={t("metrics.window")}>
        {model.ranges.map((option) => <Choice key={option.id} onClick={() => model.setRange(option.id)} pressed={model.range === option.id}>{option.label}</Choice>)}
      </Choices>}
      name={t("metrics.hostsWorldRan")}
    >
      {metrics.status === "error" && <LoadError state={metrics} title={t("metrics.metricsCouldNotLoaded")} verb={t("metrics.readMetrics")} />}
      {metrics.status === "loading" && waiting}
      {metrics.status === "ready" && metrics.value !== null && lineCharts(metrics.value)}
    </Panel>
  );
}

// The labels and final chart geometry are already useful while the readings
// arrive. One group announces the wait; the four plots do not repeat it.
const waitingSeries = [
  { id: "cpu", label: t("metrics.cpu") },
  { id: "memory", label: t("metrics.memory") },
  { id: "in", label: t("metrics.network") },
  { id: "out", label: t("metrics.networkOut") },
] as const;

const waiting: ReactNode = (
  <SkeletonGroup label={t("metrics.readingCloudWatchMetrics")}>
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

/** Where the highest reading is; null when there is none. */
export function peakIndex(points: readonly Readonly<{ value: number | null }>[]): number | null {
  let best: number | null = null;
  points.forEach((point, index) => {
    if (point.value !== null && (best === null || point.value > points[best]!.value!)) best = index;
  });
  return best;
}

/** The peak with its unit and its host's size: "1.8 of 2 cores", "42 % of host". */
const peakText = (reading: Readonly<{ value: string; unit: string }>) => `${reading.value} ${reading.unit}`;

function lineCharts(metrics: HostMetrics): ReactNode {
  return (
    <>
      {metrics.series.map((series) => {
        const scale = metricScale(series);
        const label = seriesLabel(series);
        const peakAt = peakIndex(scale.points);
        const peak = peakAt === null ? null : scale.points[peakAt]!.value;
        const runs = tracePaths(scale.points, peak);
        return (
          <section className="t-chart" key={series.id}>
            <svg aria-label={t("metrics.seriesLabelOverWindow", { seriesLabel: label })} className="t-chart-well" preserveAspectRatio="none" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
              {runs.map((run) => <polygon className="t-chart-area" key={`area-${run.from}`} points={run.area} />)}
              {runs.map((run) => <polyline className="t-chart-line" key={`line-${run.from}`} points={run.line} />)}
            </svg>
            <p className="t-chart-caption">
              <strong>{label}</strong>
              <span>{peak === null || peakAt === null ? t("metrics.noDataWindow") : rich("metrics.peakValue", { value: <strong>{peakText(scale.reading(peak, series.points[peakAt]?.capacity))}</strong> })}</span>
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
export function tracePaths(points: readonly Readonly<{ value: number | null }>[], peak: number | null): Run[] {
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
