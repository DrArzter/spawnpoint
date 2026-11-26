import { useEffect, useLayoutEffect, type RefObject } from "react";

const shown = new Map<string, number>();

/**
 * How many placeholder rows a list draws while it loads: the rows it already
 * knows (a fixed list), else as many as it showed the last time in this
 * session, else a few. A list that comes back (another world's backups) is then
 * as tall in its skeleton as in its content.
 */
export function useSkeletonRows(label: string, count: number, loading: boolean, fallback = 3): number {
  useEffect(() => {
    if (!loading) shown.set(label, count);
  }, [label, count, loading]);
  return Math.max(1, (count > 0 ? count : shown.get(label)) ?? fallback);
}

export type Tracks = Readonly<{ table: number; columns: readonly number[]; act: number | null }>;

const tracks = new Map<string, Tracks>();

/**
 * What a loading table gets back from an earlier visit: the widths, only for
 * the same columns at the same table width (±1px), else nothing, so a width
 * taken on a desktop never reaches a phone's placeholder.
 */
export function restoredTracks(known: Tracks | undefined, columns: number, width: number): Tracks | null {
  if (!known || known.columns.length !== columns || Math.abs(known.table - width) > 1) return null;
  return known;
}

/**
 * A table's column widths, kept per list like its row count. A loaded table
 * records the widths its header cells took; a loading one of the same width
 * puts them back on the header, so the columns do not move when the content
 * replaces the placeholders. The action column's content width goes to
 * --c-act-w, which its placeholder reads. Both come back only at the width
 * they were taken at; a record layout (no header shown) records nothing.
 */
export function useColumnWidths(label: string, loading: boolean, table: RefObject<HTMLTableElement | null>, rows: number): void {
  useLayoutEffect(() => {
    const element = table.current;
    const cells = element?.tHead?.rows[0] ? [...element.tHead.rows[0].cells] : [];
    if (!element || cells.length === 0) return;
    if (loading) {
      const known = restoredTracks(tracks.get(label), cells.length, element.clientWidth);
      if (!known) return;
      cells.forEach((cell, index) => { cell.style.width = `${known.columns[index]}px`; });
      if (known.act !== null) element.style.setProperty("--c-act-w", `${known.act}px`);
      return;
    }
    cells.forEach((cell) => { cell.style.width = ""; });
    element.style.removeProperty("--c-act-w");
    if (element.tHead!.offsetHeight === 0) return;
    const act = element.querySelector<HTMLElement>("tbody td.c-col-act");
    const first = act?.firstElementChild?.getBoundingClientRect();
    const last = act?.lastElementChild?.getBoundingClientRect();
    const content = first && last ? Math.round(last.right - first.left) : null;
    tracks.set(label, { table: element.clientWidth, columns: cells.map((cell) => cell.getBoundingClientRect().width), act: content });
  }, [label, loading, table, rows]);
}
