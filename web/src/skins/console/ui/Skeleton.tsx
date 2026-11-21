import type { CSSProperties, ReactNode } from "react";

import { cx } from "../../../lib/cx";

/**
 * One announced loading region. Placeholders inside it keep the final
 * geometry, so nothing jumps when the content arrives; they carry no copy.
 */
export function SkeletonGroup({ label = "Loading", className, children }: Readonly<{ label?: string; className?: string; children: ReactNode }>) {
  return <output aria-busy="true" aria-label={label} className={cx("c-skeleton-group", className)}>{children}</output>;
}

/** One placeholder block. Width and height are its final size. */
export function Skeleton({ width = "100%", height = 16, className }: Readonly<{ width?: number | string; height?: number | string; className?: string }>) {
  const style: CSSProperties = { width, height };
  return <span aria-hidden="true" className={cx("c-skeleton", className)} style={style} />;
}

/**
 * Placeholder rows for a table or a track list, at its row height. Inside a
 * Table it is the body; elsewhere it is its own announced region.
 */
export function SkeletonRows({ rows = 8, columns, inTable = false }: Readonly<{ rows?: number; columns: number; inTable?: boolean }>) {
  const lines = Array.from({ length: rows }, (_, row) => row);
  const cells = Array.from({ length: columns }, (_, cell) => cell);
  if (inTable) {
    return (
      <tbody aria-busy="true" aria-label="Loading" className="c-skeleton-rows">
        {lines.map((row) => <tr key={row}>{cells.map((cell) => <td key={cell}><Skeleton height={14} width={cell === 0 ? "70%" : "50%"} /></td>)}</tr>)}
      </tbody>
    );
  }
  return (
    <SkeletonGroup className="c-skeleton-rows">
      {lines.map((row) => <span className="c-skeleton-row" key={row}>{cells.map((cell) => <Skeleton height={14} key={cell} width={cell === 0 ? "70%" : "50%"} />)}</span>)}
    </SkeletonGroup>
  );
}
