import type { CSSProperties, ReactNode } from "react";

import type { Action } from "../../../core/actions";

import { cx } from "../../../lib/cx";
import { Skeleton } from "./Skeleton";
import { useSkeletonRows } from "./rows";
import { ARRIVED, useArrivals } from "./Tick";

/**
 * A track's role:
 * - `stack`: title and a secondary line;
 * - `num`, `end`: aligned to the end edge;
 * - `optional`: hidden under 1024px, where its content moves to the stack's second line (`compactLine`).
 */
export type TrackKind = "stack" | "num" | "end" | "optional" | "plain";

export type Track<Row> = Readonly<{
  id: string;
  header: string;
  /** The track width at 1024px and up, as a grid track: `minmax(0, 1fr)`, `120px`, `auto`. */
  width: string;
  /** The width under 1024px; leave it out for a track that is hidden there (optional) or keeps its width. */
  compactWidth?: string;
  kind?: TrackKind;
  render: (row: Row) => ReactNode;
  /** Hides the header label visually (an end action track). */
  quietHeader?: boolean;
  /** How many lines a stack cell holds, so its placeholder keeps the row's height; two by default. */
  lines?: 1 | 2;
}>;

/**
 * A short list whose rows share column tracks: one CSS grid, rows on
 * subgrid, labels once in the header. Under 1024px the row's title link
 * covers the row (link it with `TrackTitle`); controls in a row stay above it.
 */
export function TrackList<Row>({ label, tracks, rows, rowKey, empty, header = true, loading = false, arrivals = false, className }: Readonly<{
  label: string;
  tracks: readonly Track<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
  /** Draw the header row; a list of one obvious shape may leave it out. */
  header?: boolean;
  /** Placeholder rows on the same tracks, as many as the list showed last time. */
  loading?: boolean;
  /**
   * Rows that arrived while the view is open (A9). `true` works them out from
   * the rows shown, for a list that shows every row; a paged or filtered list
   * passes the set from `useArrivals` over all of the model's rows, so a page
   * turn or a cleared filter marks nothing.
   */
  arrivals?: boolean | ReadonlySet<string>;
  className?: string;
}>) {
  const tracked = useArrivals(arrivals === true ? rows.map(rowKey) : []);
  const fresh = typeof arrivals === "object" ? arrivals : tracked;
  const style = {
    "--c-tracks": tracks.map((track) => track.width).join(" "),
    "--c-tracks-compact": tracks.filter((track) => track.kind !== "optional").map((track) => track.compactWidth ?? track.width).join(" "),
  } as CSSProperties;
  const placeholders = useSkeletonRows(label, rows.length, loading);
  if (!loading && rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <div aria-busy={loading || undefined} aria-label={label} className={cx("c-tracklist", className)} data-layout="rows" role="table" style={style}>
      {header && (
        <div className="c-tracklist-head" role="row">
          {tracks.map((track, index) => (
            <span className={cx("c-track", track.kind && `c-track-${track.kind}`)} data-rail={index === 0 ? "" : undefined} key={track.id} role="columnheader">
              {track.quietHeader ? <span className="c-sr">{track.header}</span> : track.header}
            </span>
          ))}
        </div>
      )}
      {loading && Array.from({ length: placeholders }, (_, row) => (
        <div className="c-tracklist-row" data-from="1024" data-layout="one-line" key={row} role="row">
          {tracks.map((track, index) => (
            <span className={cx("c-track", track.kind && `c-track-${track.kind}`)} data-rail={index === 0 ? "" : undefined} key={track.id} role="cell">{placeholder(track, tracks.some((other) => other.kind === "optional"))}</span>
          ))}
        </div>
      ))}
      {!loading && rows.map((row) => (
        <div className={cx("c-tracklist-row", fresh.has(rowKey(row)) && ARRIVED)} data-from="1024" data-layout="one-line" key={rowKey(row)} role="row">
          {tracks.map((track, index) => (
            <span className={cx("c-track", track.kind && `c-track-${track.kind}`)} data-rail={index === 0 ? "" : undefined} key={track.id} role="cell">{track.render(row)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A cell's placeholder: a title and its line for a stack, a small block at the
 * end edge, else one line. A one-line stack in a list with optional tracks
 * also holds the second line those tracks move to under 1024px, as its rows do.
 */
function placeholder<Row>(track: Track<Row>, optional: boolean) {
  if (track.kind === "stack") {
    return (
      <span className="c-track-stack-body">
        <Skeleton text width="55%" />
        {track.lines !== 1 && <Skeleton text width="35%" />}
        {track.lines === 1 && optional && <span className="c-track-line c-track-compact"><Skeleton text width="35%" /></span>}
      </span>
    );
  }
  if (track.kind === "end") return <Skeleton height={28} width={track.quietHeader ? 72 : 48} />;
  return <Skeleton text width={track.kind === "num" ? "3em" : "60%"} />;
}

/** A stack cell: the title (a link that covers the row on narrow widths) and its secondary line. */
function titleOf(title: ReactNode, href: string | undefined, run: Action | undefined, current: boolean): ReactNode {
  if (href) return <a className="c-track-title" href={href}>{title}</a>;
  if (run) return <button aria-current={current || undefined} className="c-track-title" data-action={run.id} onClick={run.run} type="button">{title}</button>;
  return <span className="c-track-title">{title}</span>;
}

export function TrackTitle({ title, href, action: run, current = false, line, compactLine }: Readonly<{
  title: ReactNode;
  href?: string;
  /** A title that opens its row in place rather than at a link: the row's button. */
  action?: Action;
  /** The row that is open, marked as the current one. */
  current?: boolean;
  line?: ReactNode;
  /** What optional tracks show, on the second line, under 1024px. */
  compactLine?: ReactNode;
}>) {
  return (
    <span className="c-track-stack-body">
      {titleOf(title, href, run, current)}
      {line && (
        <span className="c-track-line">
          {line}
          {compactLine && <span className="c-track-compact">{compactLine}</span>}
        </span>
      )}
      {/* Only the narrow layout has a second line: none is drawn from 1024px up. */}
      {!line && compactLine && <span className="c-track-line c-track-compact">{compactLine}</span>}
    </span>
  );
}
