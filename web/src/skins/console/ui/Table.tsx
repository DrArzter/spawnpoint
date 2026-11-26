import { useRef, type ReactNode } from "react";

import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { ARRIVED, useArrivals } from "./Tick";
import { Skeleton } from "./Skeleton";
import { rememberedActWidth, useColumnWidths, useSkeletonRows } from "./rows";
import { t } from "../../../i18n";

/**
 * A column's role decides its layout:
 * - `lead`: the row's identity; on a phone it spans the record and its link covers the row;
 * - `num`: right-aligned;
 * - `act`: the one end-edge action column (one button style), sticky when the table scrolls;
 * - `wide`: drops when the table is under 960px wide;
 * - `optional`: drops when the table is under 1040px wide, and under a 1440px window beside a split panel (`split`);
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
  /** A long value: the column takes the width the others leave, and the value is cut with an ellipsis only when that runs out. */
  clip?: boolean;
  /** Header content when it is not text, such as a select-all checkbox. */
  headerCell?: ReactNode;
}>;

export type TableVariant = "default" | "fixed" | "matrix";

/**
 * One native table for one list: labels once in the header, every row on
 * the same column tracks, one action column at the end edge. At 760px of its
 * own width and up it stays a table and drops columns by kind; under it each
 * row becomes a record whose cells carry their header as a label. `matrix`
 * stays a table.
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
  const placeholders = useSkeletonRows(label, rows.length, loading);
  const table = useRef<HTMLTableElement>(null);
  useColumnWidths(label, loading, table, rows.length);
  return (
    <div className={cx("c-table-wrap", split && "c-table-split", className)}>
      <table aria-label={label} className={cx("c-table", variant !== "default" && `c-table-${variant}`)} data-layout="rows" ref={table}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th aria-sort={column.sort ?? undefined} className={cx(column.kind && `c-col-${column.kind}`, column.clip && "c-col-clip", column.className)} data-col={column.kind === "act" ? "actions" : undefined} data-rail={index === 0 ? "" : undefined} key={column.id} scope="col">
                {column.headerCell ?? <HeaderLabel column={column} />}
              </th>
            ))}
          </tr>
        </thead>
        {loading ? <LoadingBody act={rememberedActWidth(label)} columns={columns} count={placeholders} /> : (
          <tbody>
            {rows.length === 0 && empty !== undefined && <tr className="c-table-empty"><td colSpan={columns.length}>{empty}</td></tr>}
            {rows.map((row) => (
              <tr className={cx(selected?.(row) && "c-row-selected", fresh.has(rowKey(row)) && ARRIVED) || undefined} key={rowKey(row)}>
                {columns.map((column, index) => (
                  <td className={cx(column.kind && `c-col-${column.kind}`, column.clip && "c-col-clip", column.className)} data-col={column.kind === "act" ? "actions" : undefined} data-rail={index === 0 ? "" : undefined} data-label={column.kind === "act" || column.kind === "lead" || column.kind === "check" ? undefined : column.header} key={column.id}>
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

/**
 * A cell's placeholder: the size of what the column holds, so the row keeps its
 * height. The action column holds one block as wide as its actions were the
 * last time, else as wide as two small controls.
 */
function placeholder(kind: ColumnKind | undefined, act: number | null) {
  if (kind === "act") return <Skeleton height="var(--c-ctl-sm)" width={act ?? "calc(2 * var(--c-ctl-sm))"} />;
  if (kind === "check") return <Skeleton height={18} width={18} />;
  const width = { lead: "60%", num: "3em" } as Readonly<Partial<Record<ColumnKind, string>>>;
  return <Skeleton text width={(kind && width[kind]) ?? "50%"} />;
}

/** The rows of a table that is loading: the same cells, classes and labels as a loaded row. */
function LoadingBody<Row>({ columns, count, act }: Readonly<{ columns: readonly Column<Row>[]; count: number; act: number | null }>) {
  return (
    <tbody aria-busy="true" aria-label={t("common.loading")}>
      {Array.from({ length: count }, (_, row) => (
        <tr key={row}>
          {columns.map((column, index) => (
            <td className={cx(column.kind && `c-col-${column.kind}`, column.clip && "c-col-clip", column.className)} data-col={column.kind === "act" ? "actions" : undefined} data-label={column.kind === "act" || column.kind === "lead" || column.kind === "check" ? undefined : column.header} data-rail={index === 0 ? "" : undefined} key={column.id}>
              {placeholder(column.kind, act)}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function sortIcon(sort: SortDirection | null | undefined): IconName {
  if (sort === "descending") return "arrow_downward";
  return sort === "ascending" ? "arrow_upward" : "unfold_more";
}

function HeaderLabel<Row>({ column }: Readonly<{ column: Column<Row> }>) {
  if (column.kind === "act") return <span className="c-sr">{column.header}</span>;
  if (!column.onSort) return <>{column.header}</>;
  return (
    <button className="c-sort" onClick={column.onSort} type="button">
      <span>{column.header}</span>
      <Icon name={sortIcon(column.sort)} size={15} />
    </button>
  );
}

/** The next sort state when a header is pressed: ascending first, then descending. */
export function nextSort(current: SortDirection | null | undefined): SortDirection {
  return current === "ascending" ? "descending" : "ascending";
}
