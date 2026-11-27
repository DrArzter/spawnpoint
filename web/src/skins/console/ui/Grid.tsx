import type { ReactNode } from "react";

import { cx } from "../../../lib/cx";

/**
 * The content grid. Auto kinds add columns with width from a minimum column;
 * fixed kinds keep the prototype's accepted column counts. Every kind
 * stretches the cards of one row to one height (R11).
 */
export type GridKind = "detail" | "stat" | "name" | "home" | "metrics" | "profile" | "stack";

/** A `fill` grid takes the free height of its tab panel, and its row of cards grows with it. */
export function Grid({ kind, className, children, label, fill = false }: Readonly<{ kind: GridKind; className?: string; label?: string; fill?: boolean; children: ReactNode }>) {
  return <div aria-label={label} className={cx("c-grid", `c-grid-${kind}`, className)} data-fill={fill || undefined} data-layout="grid" role={label ? "group" : undefined} /* NOSONAR a named region of cards; <fieldset> is for form controls */>{children}</div>;
}

/** How many columns of a fixed grid a cell spans. */
export function GridCell({ span, className, children }: Readonly<{ span: "2" | "2-wide" | "full"; className?: string; children: ReactNode }>) {
  return <div className={cx("c-grid-cell", `c-span-${span}`, className)}>{children}</div>;
}
