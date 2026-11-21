import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { action } from "../../../core/actions";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";
import { Table } from "./Table";

export type ChartPoint = Readonly<{ at: string; value: number | null }>;

/** The plot's own units: the SVG stretches to its box, so lines keep their width with non-scaling strokes. */
export const PLOT = { width: 600, height: 200, inset: 4 } as const;

/** The top of the y axis: 100 for a percentage, else the peak rounded up to 1, 2 or 5 of its power of ten. */
export function chartMax(points: readonly ChartPoint[], percent: boolean): number {
  if (percent) return 100;
  const peak = Math.max(0, ...points.map((point) => point.value ?? 0));
  if (peak <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 2, 5, 10].find((factor) => factor * power >= peak) ?? 10;
  return step * power;
}

export type ChartGeometry = Readonly<{
  /** One path per run of readings; a missing reading ends a run, it is never joined over. */
  lines: readonly string[];
  areas: readonly string[];
  /** A run of one reading, drawn as a dot. */
  dots: readonly Readonly<{ x: number; y: number }>[];
  /** Where the host reported nothing, as x ranges. */
  gaps: readonly Readonly<{ x: number; width: number }>[];
}>;

export function pointX(index: number, count: number): number {
  return count <= 1 ? PLOT.width / 2 : (index * PLOT.width) / (count - 1);
}

export function pointY(value: number, max: number): number {
  const span = PLOT.height - PLOT.inset * 2;
  return PLOT.inset + span * (1 - Math.min(value, max) / max);
}

export function chartGeometry(points: readonly ChartPoint[], max: number): ChartGeometry {
  const runs: { x: number; y: number }[][] = [];
  const gaps: { x: number; width: number }[] = [];
  let run: { x: number; y: number }[] = [];
  let gapStart: number | null = null;
  points.forEach((point, index) => {
    if (point.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      gapStart ??= index;
      return;
    }
    if (gapStart !== null) {
      const from = pointX(Math.max(0, gapStart - 1), points.length);
      gaps.push({ x: from, width: pointX(index, points.length) - from });
      gapStart = null;
    }
    run.push({ x: pointX(index, points.length), y: pointY(point.value, max) });
  });
  if (run.length > 0) runs.push(run);
  if (gapStart !== null) {
    const from = pointX(Math.max(0, gapStart - 1), points.length);
    gaps.push({ x: from, width: PLOT.width - from });
  }
  const base = pointY(0, max);
  const path = (list: readonly { x: number; y: number }[]) => list.map((at, index) => `${index === 0 ? "M" : "L"}${at.x.toFixed(1)},${at.y.toFixed(1)}`).join(" ");
  const long = runs.filter((list) => list.length > 1);
  return {
    lines: long.map(path),
    areas: long.map((list) => `${path(list)} L${list.at(-1)!.x.toFixed(1)},${base} L${list[0]!.x.toFixed(1)},${base} Z`),
    dots: runs.filter((list) => list.length === 1).map((list) => list[0]!),
    gaps,
  };
}

/** Where a key moves the cursor: arrows step one reading, Home and End jump; null for any other key. */
export function nextCursor(key: string, cursor: number | null, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  const from = cursor ?? last;
  if (key === "ArrowRight") return Math.min(last, from + 1);
  if (key === "ArrowLeft") return Math.max(0, from - 1);
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

/** The latest, peak and average of the readings there are; null when there are none. */
export function chartSummary(points: readonly ChartPoint[]): Readonly<{ latest: number; peak: ChartPoint & { value: number }; average: number; count: number }> | null {
  const known = points.filter((point): point is ChartPoint & { value: number } => point.value !== null);
  if (known.length === 0) return null;
  const peak = known.reduce((best, point) => (point.value > best.value ? point : best));
  return { latest: known.at(-1)!.value, peak, average: known.reduce((sum, point) => sum + point.value, 0) / known.length, count: known.length };
}

/**
 * A measured series over time, drawn in SVG. Missing readings are hatched
 * gaps, never joined. A pointer or touch moves a crosshair with the time and
 * value; on keyboard focus the arrows move a cursor point by point, Home and
 * End jump, and the reading is announced. "Show data" lists every reading.
 */
export function TimeSeriesChart({ label, range, points, format, time, percent = false, reveal = false }: Readonly<{
  label: string;
  /** The window in words, for the accessible name: "24 hours". */
  range: string;
  points: readonly ChartPoint[];
  format: (value: number) => string;
  /** A reading's time as the axis and the tooltip say it. */
  time: (at: string) => string;
  percent?: boolean;
  /** Draws the line in from the start of the window (A5). */
  reveal?: boolean;
}>) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const max = chartMax(points, percent);
  const shape = chartGeometry(points, max);
  const summary = chartSummary(points);
  const name = [label, range, summary ? `latest ${format(summary.latest)}` : "no readings", summary ? `peak ${format(summary.peak.value)}` : null].filter(Boolean).join(", ");
  const at = cursor === null ? null : points[cursor] ?? null;
  const reading = at ? `${time(at.at)}: ${at.value === null ? "No reading" : format(at.value)}` : "";

  const onPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || points.length === 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setCursor(Math.round(ratio * (points.length - 1)));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextCursor(event.key, cursor, points.length);
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
  };

  const left = cursor === null ? 0 : (pointX(cursor, points.length) / PLOT.width) * 100;
  const top = at?.value != null ? (pointY(at.value, max) / PLOT.height) * 100 : null;
  return (
    <div className={cx("c-chart", reveal && "c-chart-reveal")}>
      <div className="c-chart-plot">
        <div aria-hidden="true" className="c-chart-axis">
          {[max, max / 2, 0].map((tick) => <span key={tick}>{format(tick)}</span>)}
        </div>
        <div
          aria-label={name}
          aria-roledescription="chart"
          className="c-chart-area"
          onBlur={() => setCursor(null)}
          onKeyDown={onKey}
          onPointerDown={onPointer}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") setCursor(null); }}
          onPointerMove={onPointer}
          role="group"
          tabIndex={0}
        >
          <svg aria-hidden="true" className="c-chart-svg" preserveAspectRatio="none" viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}>
            <defs>
              <pattern height="6" id={`${id}-hatch`} patternTransform="rotate(45)" patternUnits="userSpaceOnUse" width="6">
                <rect className="c-chart-hatch-ground" height="6" width="6" />
                <line className="c-chart-hatch-line" x1="0" x2="0" y1="0" y2="6" />
              </pattern>
            </defs>
            {[max, max / 2, 0].map((tick) => <line className="c-chart-grid" key={tick} x1="0" x2={PLOT.width} y1={pointY(tick, max)} y2={pointY(tick, max)} />)}
            <g className="c-chart-data">
              {shape.gaps.map((gap) => <rect fill={`url(#${id}-hatch)`} height={PLOT.height - PLOT.inset * 2} key={gap.x} width={gap.width} x={gap.x} y={PLOT.inset} />)}
              {shape.areas.map((area) => <path className="c-chart-fill" d={area} key={area} />)}
              {shape.lines.map((line) => <path className="c-chart-line" d={line} key={line} />)}
            </g>
          </svg>
          {/* Lone readings are HTML marks: the stretched SVG would draw a circle as an ellipse. */}
          {shape.dots.map((dot) => <span aria-hidden="true" className="c-chart-point" key={dot.x} style={{ left: `${(dot.x / PLOT.width) * 100}%`, top: `${(dot.y / PLOT.height) * 100}%` }} />)}
          {at && (
            <>
              <span aria-hidden="true" className="c-chart-cross" style={{ left: `${left}%` }} />
              {top !== null && <span aria-hidden="true" className="c-chart-dot" style={{ left: `${left}%`, top: `${top}%` }} />}
              <span aria-hidden="true" className={cx("c-chart-tip", left > 70 && "c-chart-tip-end")} style={{ left: `${left}%` }}>
                <span>{time(at.at)}</span>
                <strong>{at.value === null ? "No reading" : format(at.value)}</strong>
              </span>
            </>
          )}
          <span aria-live="polite" className="c-sr">{reading}</span>
        </div>
      </div>
      <div className="c-chart-foot">
        <ActionButton action={action("chart.data", table ? "Hide data" : "Show data", () => setTable((open) => !open), { icon: table ? "expand_less" : "expand_more" })} size="sm" variant="ghost" />
      </div>
      {table && (
        <Table
          columns={[
            { id: "time", header: "Time", kind: "lead", render: (point) => time(point.at) },
            { id: "value", header: label, kind: "num", render: (point) => point.value === null ? <span className="c-faint">No reading</span> : format(point.value) },
          ]}
          label={`${label} readings`}
          rowKey={(point) => point.at}
          rows={points}
        />
      )}
    </div>
  );
}
