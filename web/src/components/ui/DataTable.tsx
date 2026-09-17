import type { ReactNode } from "react";

import { cx } from "../../lib/cx";
import { Skeleton } from "./Skeleton";

export type Column<Row> = {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  width?: string;
  align?: "start" | "end" | "num";
  actions?: boolean;
  // Dropped where the table would otherwise push its actions off the screen.
  // The column a reader came for must never be the one that scrolls away.
  secondary?: boolean;
  // Cut with an ellipsis rather than allowed to set the table's width. For a
  // value that is copied rather than read, such as a file name.
  truncate?: boolean;
};

export function DataTable<Row>({ columns, rows, rowKey, label, empty = "No items", loading = false, loadingRows = 3, selectedKey, className, hideHeader = false, decision = false }: {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  label: string;
  empty?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  selectedKey?: string | null;
  className?: string;
  /**
   * For a table whose columns say what they are: a person, a labelled control,
   * an action. The row stays in the markup so the table is still navigable by
   * column for anybody reading it aloud — it just stops taking a line.
   */
  hideHeader?: boolean;
  /**
   * For a row laid out as person, control, decision. On the Medium step the
   * person keeps the first line and the control and the decision share the
   * second, so neither is squeezed against the other while the row is still
   * too wide to stack into a record.
   */
  decision?: boolean;
}) {
  const cellClass = (column: Column<Row>) => cx(column.actions && "cell-actions", column.align === "end" && "cell-end", column.align === "num" && "cell-num", column.secondary && "cell-secondary", column.truncate && "cell-truncate");
  return (
    <div className={cx("table-wrap", decision && "table-decision", className)}>
      <table aria-busy={loading || undefined} aria-label={label} className="table">
        <colgroup>{columns.map((column) => <col className={cx(column.secondary && "cell-secondary")} key={column.id} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
        <thead className={cx(hideHeader && "visually-hidden")}>
          <tr>{columns.map((column) => <th className={cellClass(column)} key={column.id} scope="col">{column.actions || hideHeader ? <span className="visually-hidden">{column.label}</span> : column.label}</th>)}</tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: loadingRows }, (_, index) => (
            <tr aria-hidden="true" className="table-skeleton" key={`skeleton-${index}`}>
              {columns.map((column) => <td className={cellClass(column)} data-label={column.label} key={column.id}><Skeleton width={column.actions ? "48px" : `${55 + ((index * 17 + column.id.length * 7) % 35)}%`} /></td>)}
            </tr>
          ))}
          {!loading && rows.length === 0 && <tr><td className="table-empty" colSpan={columns.length}>{empty}</td></tr>}
          {!loading && rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr aria-selected={selectedKey === key || undefined} key={key}>
                {columns.map((column) => <td className={cellClass(column)} data-label={column.actions ? "" : column.label} key={column.id}>{column.render(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
