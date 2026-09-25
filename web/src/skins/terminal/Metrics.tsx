import type { ReactNode } from "react";

import type { HostMetricPoint, HostMetrics } from "../../api/contract";
import { Skeleton } from "../../components/ui/Skeleton";
import { Timestamp } from "../../components/ui/Timestamp";
import type { MetricsModel } from "../../core/models";
import { MetricsPage, formatMetric, seriesPeak } from "../console/Metrics";

// Metrics the way the status page draws its response line: one series is one
// well with the area under its line filled in the accent, no axes and no
// grid, a caption under it with the one number worth reading, and the window
// stated once for all of them. A gap in the readings is a gap in the line,
// not a line drawn to zero.
const WIDTH = 480;
const HEIGHT = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 12;

export function Metrics({ model }: Readonly<{ model: MetricsModel }>) {
  return <MetricsPage chart={lineCharts} model={model} placeholder={placeholder} />;
}

// While the numbers load: the wells at their size, with a caption line under
// each, so nothing moves when they arrive.
const placeholder = (
  <>
    {["cpu", "in", "out"].map((id) => (
      <div className="tchart-placeholder" key={id}>
        <Skeleton height={HEIGHT} />
        <Skeleton height={16} width="32%" />
      </div>
    ))}
  </>
);

function lineCharts(metrics: HostMetrics): ReactNode {
  return (
    <>
      {metrics.series.map((series) => {
        const peak = seriesPeak(series.points);
        const format = formatMetric(series.unit);
        const runs = tracePaths(series.points, peak);
        return (
          <section className="tchart" key={series.id}>
            <svg aria-label={`${series.label} over the window`} className="tchart-well" preserveAspectRatio="none" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
              {runs.map((run) => <polygon className="tchart-area" key={`area-${run.from}`} points={run.area} />)}
              {runs.map((run) => <polyline className="tchart-line" key={`line-${run.from}`} points={run.line} />)}
            </svg>
            <p className="tchart-caption">
              <strong>{series.label}</strong>
              <span>{peak === null ? "no data in this window" : <>peak <strong>{format(peak)}</strong></>}</span>
            </p>
          </section>
        );
      })}
      <div className="tchart-scale">
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
