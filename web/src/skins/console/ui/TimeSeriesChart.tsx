import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { action } from "../../../core/actions";
import { cx } from "../../../lib/cx";
import { ActionButton } from "./ActionButton";
import { Skeleton } from "./Skeleton";
import { Table } from "./Table";
import { t } from "../../../i18n";

/** `interpolated`: joined between two real readings by the server (memory only, see DESIGN.md). */
export type ChartPoint = Readonly<{ at: string; value: number | null; interpolated?: boolean }>;

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
  /** One path per run of readings; a missing reading ends a run, it is never joined over. The one exception is a reading the server flagged `interpolated`: it is a reading here. */
  lines: readonly string[];
  areas: readonly string[];
  /** A run of one reading, drawn as a dot. */
  dots: readonly Readonly<{ x: number; y: number }>[];
  /** Where the host reported nothing, as x ranges. */
  gaps: readonly Readonly<{ x: number; width: number }>[];
  /** The newest slots, which the readings have not reached yet: a neutral band, not a gap. */
  pending: Readonly<{ x: number; width: number }> | null;
}>;

export function pointX(index: number, count: number): number {
  return count <= 1 ? PLOT.width / 2 : (index * PLOT.width) / (count - 1);
}

export function pointY(value: number, max: number): number {
  const span = PLOT.height - PLOT.inset * 2;
  return PLOT.inset + span * (1 - Math.min(value, max) / max);
}

/**
 * The first pending slot, or null. Only an empty tail can be pending: a
 * reading in it would mean the server's mark is wrong, and it is ignored.
 */
export function pendingIndex(points: readonly ChartPoint[], pendingFrom: string | null | undefined): number | null {
  if (!pendingFrom) return null;
  const index = points.findIndex((point) => point.at >= pendingFrom);
  return index >= 0 && points.slice(index).every((point) => point.value === null) ? index : null;
}

export function chartGeometry(points: readonly ChartPoint[], max: number, pendingFrom?: string | null): ChartGeometry {
  const runs: { x: number; y: number }[][] = [];
  const gaps: { x: number; width: number }[] = [];
  const tail = pendingIndex(points, pendingFrom);
  const end = tail ?? points.length;
  let run: { x: number; y: number }[] = [];
  let gapStart: number | null = null;
  points.slice(0, end).forEach((point, index) => {
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
  const edge = tail === null ? PLOT.width : pointX(Math.max(0, end - 1), points.length);
  if (gapStart !== null) {
    const from = pointX(Math.max(0, gapStart - 1), points.length);
    gaps.push({ x: from, width: edge - from });
  }
  const base = pointY(0, max);
  const path = (list: readonly { x: number; y: number }[]) => list.map((at, index) => `${index === 0 ? "M" : "L"}${at.x.toFixed(1)},${at.y.toFixed(1)}`).join(" ");
  const long = runs.filter((list) => list.length > 1);
  return {
    lines: long.map(path),
    areas: long.map((list) => `${path(list)} L${list.at(-1)!.x.toFixed(1)},${base} L${list[0]!.x.toFixed(1)},${base} Z`),
    dots: runs.filter((list) => list.length === 1).map((list) => list[0]!),
    gaps,
    pending: tail === null ? null : { x: edge, width: PLOT.width - edge },
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
  // A joined point is a line, not a measurement: it never counts as latest, peak or average.
  const known = points.filter((point): point is ChartPoint & { value: number } => point.value !== null && point.interpolated !== true);
  if (known.length === 0) return null;
  const peak = known.reduce((best, point) => (point.value > best.value ? point : best), known[0]);
  return { latest: known.at(-1)!.value, peak, average: known.reduce((sum, point) => sum + point.value, 0) / known.length, count: known.length };
}

/** What a reading says for itself: its value, "Joined" beside a joined one, "No reading" for a gap, "Not reported yet" for the pending tail. */
export function readingValue(point: ChartPoint, format: (value: number) => string, pending: boolean): string {
  if (point.value === null) return pending ? t("common.notReportedYet") : t("ui.noReading");
  return point.interpolated ? t("ui.valueJoined", { value: format(point.value) }) : format(point.value);
}

/** What a series draws besides its line, for the legend. */
export function chartNotes(points: readonly ChartPoint[], pendingFrom?: string | null): Readonly<{ gaps: boolean; pending: boolean }> {
  const shape = chartGeometry(points, 1, pendingFrom);
  return { gaps: shape.gaps.length > 0, pending: shape.pending !== null };
}

/** The announced reading: its time, then its value. */
function readingText(at: ChartPoint | null, time: (at: string) => string, format: (value: number) => string, pending: boolean): string {
  if (!at) return "";
  return `${time(at.at)}: ${readingValue(at, format, pending)}`;
}

/**
 * A measured series over time, drawn in SVG. Missing readings are hatched
 * gaps, never joined; the newest slots of a running session are a neutral
 * "not reported yet" band instead. A reading the server flagged `interpolated`
 * is the one exception to "never joined": memory is probed every 15 minutes. A pointer or touch moves a crosshair with the time and
 * value; on keyboard focus the arrows move a cursor point by point, Home and
 * End jump, and the reading is announced. "Show data" lists every reading.
 */
export function TimeSeriesChart({ label, range, points, format, time, percent = false, reveal = false, pendingFrom = null }: Readonly<{
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
  /** The first slot not reported yet while the session runs. */
  pendingFrom?: string | null;
}>) {
  const [cursor, setCursor] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const max = chartMax(points, percent);
  const shape = chartGeometry(points, max, pendingFrom);
  const pendingAt = pendingIndex(points, pendingFrom);
  const summary = chartSummary(points);
  const name = [label, range, summary ? t("ui.latestValue", { value: format(summary.latest) }) : t("ui.noReadings"), summary ? t("ui.peakValue", { value: format(summary.peak.value) }) : null].filter(Boolean).join(", ");
  const at = cursor === null ? null : points[cursor] ?? null;
  const reading = readingText(at, time, format, pendingAt !== null && cursor !== null && cursor >= pendingAt);

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
        <div // NOSONAR a focusable chart region: the arrow keys and pointer move a cursor through the readings
          aria-label={name}
          aria-roledescription="chart"
          className="c-chart-area"
          onBlur={() => setCursor(null)}
          onKeyDown={onKey}
          onPointerDown={onPointer}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") setCursor(null); }}
          onPointerMove={onPointer}
          role="group"
          tabIndex={0} // NOSONAR the region is the keyboard stop for the cursor
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
              {shape.pending && <rect className="c-chart-pending" height={PLOT.height - PLOT.inset * 2} width={shape.pending.width} x={shape.pending.x} y={PLOT.inset} />}
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
                <strong>{readingValue(at, format, pendingAt !== null && cursor !== null && cursor >= pendingAt)}</strong>
              </span>
            </>
          )}
          <span aria-live="polite" className="c-sr">{reading}</span>
        </div>
      </div>
      <div className="c-chart-foot">
        <ActionButton action={action("chart.data", table ? t("ui.hideData") : t("ui.showData"), () => setTable((open) => !open), { icon: table ? "expand_less" : "expand_more" })} size="sm" variant="ghost" />
      </div>
      {table && (
        <Table
          columns={[
            { id: "time", header: t("common.time"), kind: "lead", render: (point) => time(point.at) },
            { id: "value", header: label, kind: "num", render: (point) => point.value === null ? <span className="c-faint">{readingValue(point, format, pendingAt !== null && point.at >= (pendingFrom ?? ""))}</span> : readingValue(point, format, false) },
          ]}
          label={t("ui.labelReadings", { label })}
          rowKey={(point) => point.at}
          rows={points}
        />
      )}
    </div>
  );
}

/** A chart that is still loading: the axis column, the plot box and the data key, at their final size. */
export function ChartSkeleton() {
  return (
    <div className="c-chart">
      <div className="c-chart-plot">
        <div aria-hidden="true" className="c-chart-axis">
          {[0, 1, 2].map((tick) => <Skeleton height={12} key={tick} width={26} />)}
        </div>
        <div className="c-chart-area"><Skeleton height="100%" /></div>
      </div>
      <div className="c-chart-foot"><Skeleton height="var(--c-ctl-sm)" width={96} /></div>
    </div>
  );
}
