import { ReactNode } from "react";

export type DataColumn<Row> = {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  width?: string;
};

export function DataTable<Row>({ columns, emptyLabel = "No items", label, rowKey, rows }: {
  columns: readonly DataColumn<Row>[];
  emptyLabel?: string;
  label: string;
  rowKey: (row: Row) => string | number;
  rows: readonly Row[];
}) {
  return <div className="ui-table-scroll"><table aria-label={label} className="ui-table" style={{ "--table-columns": columns.map((column) => column.width ?? "minmax(0, 1fr)").join(" ") } as React.CSSProperties}>
    <thead><tr>{columns.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td data-label={column.label} key={column.id}>{column.render(row)}</td>)}</tr>) : <tr><td className="ui-table-empty" colSpan={columns.length}>{emptyLabel}</td></tr>}</tbody>
  </table></div>;
}
