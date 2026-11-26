import type { CSSProperties, ReactNode } from "react";

import { cx } from "../../../lib/cx";
import { t } from "../../../i18n";

/**
 * One announced loading region. Placeholders inside it keep the final
 * geometry, so nothing jumps when the content arrives; they carry no copy.
 * `flow` lays the placeholders out in the parent's own layout, where the
 * content they stand for will sit, instead of in a column of their own.
 */
export function SkeletonGroup({ label = t("common.loading"), flow = false, className, children }: Readonly<{ label?: string; flow?: boolean; className?: string; children: ReactNode }>) {
  return <output aria-busy="true" aria-label={label} className={cx("c-skeleton-group", flow && "c-skeleton-flow", className)}>{children}</output>;
}

/**
 * One placeholder block. A `text` block is one line of its container's text:
 * it is exactly as tall as the line it stands for, so a card, a row or a stat
 * keeps the height of the real thing. A `fill` block takes the free height of
 * its column, as a filling text area does. Any other block gives its final size.
 */
export function Skeleton({ width = "100%", height = 16, text = false, fill = false, className }: Readonly<{ width?: number | string; height?: number | string; text?: boolean; fill?: boolean; className?: string }>) {
  const style: CSSProperties = text || fill ? { width } : { width, height };
  return <span aria-hidden="true" className={cx("c-skeleton", text && "c-skeleton-text", fill && "c-skeleton-fill", className)} style={style} />;
}
