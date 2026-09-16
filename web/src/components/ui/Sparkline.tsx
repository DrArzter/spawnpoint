import { cx } from "../../lib/cx";

const WIDTH = 600;
const HEIGHT = 40;

export type SparkPoint = Readonly<{ at: string; value: number | null }>;

// One line, no axes, in the grammar the status page settled on: it answers "was
// it busy, and when", which is the only question this chart is asked. A gap is a
// break in the line rather than a straight segment across it — an instance that
// was stopped reported nothing, and pretending otherwise draws a flat lie.
export function Sparkline({ points, label, format, className }: Readonly<{
  points: readonly SparkPoint[];
  label: string;
  format: (value: number) => string;
  className?: string;
}>) {
  const known = points.filter((point) => point.value !== null);
  if (known.length < 2) return null;
  const peak = Math.max(...known.map((point) => point.value ?? 0), Number.EPSILON);
  const step = WIDTH / Math.max(points.length - 1, 1);

  // Consecutive runs, so a gap ends one polyline and starts the next.
  const runs: string[][] = [];
  points.forEach((point, index) => {
    if (point.value === null) { runs.push([]); return; }
    const y = HEIGHT - 3 - (point.value / peak) * (HEIGHT - 6);
    (runs.at(-1) ?? runs[runs.push([]) - 1]!).push(`${(index * step).toFixed(1)},${y.toFixed(1)}`);
  });

  return (
    <svg aria-label={`${label}, peak ${format(peak)}`} className={cx("spark", className)} preserveAspectRatio="none" role="img" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      {/* The floor spans the whole window, so a stretch with no line reads as a
          host that was not running rather than as a chart that starts late. */}
      <line className="spark-floor" x1="0" x2={WIDTH} y1={HEIGHT - 3} y2={HEIGHT - 3} />
      {runs.filter((run) => run.length > 1).map((run) => <polyline className="spark-line" key={run[0]} points={run.join(" ")} />)}
    </svg>
  );
}
