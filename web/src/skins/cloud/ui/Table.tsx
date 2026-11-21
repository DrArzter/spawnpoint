import type { ReactNode } from "react";

import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { ARRIVED, useArrivals } from "./Tick";
import { SkeletonRows } from "./Skeleton";

/**
 * A column's role decides its layout:
 * - `lead`: the row's identity; on a phone it spans the record and its link covers the row;
 * - `num`: right-aligned;
 * - `act`: the one end-edge action column (one button style), sticky when the table scrolls;
 * - `wide`: drops under 1024px;
 * - `optional`: drops under 1440px when the table sits beside a split panel (`split`);
 * - `check`: a selection checkbox.
 */
export type ColumnKind = "lead" | "num" | "act" | "wide" | "optional" | "check";
export type SortDirection = "ascending" | "descending";

export type Column<Row> = Readonly<{
  id: string;
  /** The header text; also the record label on a phone. `act` columns name themselves "Actions" for assistive technology. */
  header: string;
  render: (row: Row) => ReactNode;
  kind?: ColumnKind;
  /** The column is sorted this way now; with `onSort`, its header is a button. */
  sort?: SortDirection | null;
  onSort?: () => void;
  /** A width class the page owns, for a column that must not squeeze. */
  className?: string;
  /** Header content when it is not text, such as a select-all checkbox. */
  headerCell?: ReactNode;
}>;

export type TableVariant = "default" | "fixed" | "matrix";

/**
 * One native table for one list: labels once in the header, every row on
 * the same column tracks, one action column at the end edge. At 760px and up
 * it stays a table and drops columns by kind; under it each row becomes a
 * record whose cells carry their header as a label. `matrix` stays a table.
 */
export function Table<Row>({ label, columns, rows, rowKey, selected, empty, loading = false, variant = "default", split = false, arrivals = false, className }: Readonly<{
  label: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  selected?: (row: Row) => boolean;
  /** Drawn in one row across the table when there are no rows. */
  empty?: ReactNode;
  loading?: boolean;
  variant?: TableVariant;
  /** The table shares its width with a split panel. */
  split?: boolean;
  /**
   * Rows that arrived while the view is open (A9). `true` works them out from
   * the rows shown, for a table that shows every row; a paged or filtered table
   * passes the set from `useArrivals` over all of the model's rows, so a page
   * turn or a cleared filter marks nothing.
   */
  arrivals?: boolean | ReadonlySet<string>;
  className?: string;
}>) {
  const tracked = useArrivals(arrivals === true ? rows.map(rowKey) : []);
  const fresh = typeof arrivals === "object" ? arrivals : tracked;
  return (
    <div className={cx("c-table-wrap", split && "c-table-split", className)}>
      <table aria-label={label} className={cx("c-table", variant !== "default" && `c-table-${variant}`)}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th aria-sort={column.sort ?? undefined} className={cx(column.kind && `c-col-${column.kind}`, column.className)} key={column.id} scope="col">
                {column.headerCell ?? <HeaderLabel column={column} />}
              </th>
            ))}
          </tr>
        </thead>
        {loading ? <SkeletonRows columns={columns.length} inTable /> : (
          <tbody>
            {rows.length === 0 && empty !== undefined && <tr className="c-table-empty"><td colSpan={columns.length}>{empty}</td></tr>}
            {rows.map((row) => (
              <tr className={cx(selected?.(row) && "c-row-selected", fresh.has(rowKey(row)) && ARRIVED) || undefined} key={rowKey(row)}>
                {columns.map((column) => (
                  <td className={cx(column.kind && `c-col-${column.kind}`, column.className)} data-label={column.kind === "act" || column.kind === "lead" || column.kind === "check" ? undefined : column.header} key={column.id}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function HeaderLabel<Row>({ column }: Readonly<{ column: Column<Row> }>) {
  if (column.kind === "act") return <span className="c-sr">{column.header}</span>;
  if (!column.onSort) return <>{column.header}</>;
  return (
    <button className="c-sort" onClick={column.onSort} type="button">
      <span>{column.header}</span>
      <Icon name={column.sort === "descending" ? "arrow_downward" : column.sort === "ascending" ? "arrow_upward" : "unfold_more"} size={15} />
    </button>
  );
}

/** The next sort state when a header is pressed: ascending first, then descending. */
export function nextSort(current: SortDirection | null | undefined): SortDirection {
  return current === "ascending" ? "descending" : "ascending";
}
