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
};

export function DataTable<Row>({ columns, rows, rowKey, label, empty = "No items", loading = false, loadingRows = 3, selectedKey, className }: {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  label: string;
  empty?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  selectedKey?: string | null;
  className?: string;
}) {
  const cellClass = (column: Column<Row>) => cx(column.actions && "cell-actions", column.align === "end" && "cell-end", column.align === "num" && "cell-num");
  return (
    <div className={cx("table-wrap", className)}>
      <table aria-busy={loading || undefined} aria-label={label} className="table">
        <colgroup>{columns.map((column) => <col key={column.id} style={column.width ? { width: column.width } : undefined} />)}</colgroup>
        <thead>
          <tr>{columns.map((column) => <th className={cellClass(column)} key={column.id} scope="col">{column.actions ? <span className="visually-hidden">{column.label}</span> : column.label}</th>)}</tr>
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
