import type { CSSProperties, ReactNode } from "react";

import { cx } from "../../../lib/cx";

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
}>;

/**
 * A short list whose rows share column tracks: one CSS grid, rows on
 * subgrid, labels once in the header. Under 1024px the row's title link
 * covers the row (link it with `TrackTitle`); controls in a row stay above it.
 */
export function TrackList<Row>({ label, tracks, rows, rowKey, empty, header = true, className }: Readonly<{
  label: string;
  tracks: readonly Track<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
  /** Draw the header row; a list of one obvious shape may leave it out. */
  header?: boolean;
  className?: string;
}>) {
  const style = {
    "--c-tracks": tracks.map((track) => track.width).join(" "),
    "--c-tracks-compact": tracks.filter((track) => track.kind !== "optional").map((track) => track.compactWidth ?? track.width).join(" "),
  } as CSSProperties;
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <div aria-label={label} className={cx("c-tracklist", className)} role="table" style={style}>
      {header && (
        <div className="c-tracklist-head" role="row">
          {tracks.map((track) => (
            <span className={cx("c-track", track.kind && `c-track-${track.kind}`)} key={track.id} role="columnheader">
              {track.quietHeader ? <span className="c-sr">{track.header}</span> : track.header}
            </span>
          ))}
        </div>
      )}
      {rows.map((row) => (
        <div className="c-tracklist-row" key={rowKey(row)} role="row">
          {tracks.map((track) => (
            <span className={cx("c-track", track.kind && `c-track-${track.kind}`)} key={track.id} role="cell">{track.render(row)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A stack cell: the title (a link that covers the row on narrow widths) and its secondary line. */
export function TrackTitle({ title, href, line, compactLine }: Readonly<{ title: ReactNode; href?: string; line?: ReactNode; /** What optional tracks show, on the second line, under 1024px. */ compactLine?: ReactNode }>) {
  return (
    <span className="c-track-stack-body">
      {href ? <a className="c-track-title" href={href}>{title}</a> : <span className="c-track-title">{title}</span>}
      {(line || compactLine) && (
        <span className="c-track-line">
          {line}
          {compactLine && <span className="c-track-compact">{compactLine}</span>}
        </span>
      )}
    </span>
  );
}
