import type { CSSProperties, ReactNode } from "react";

import { cx } from "../../../lib/cx";

/**
 * One announced loading region. Placeholders inside it keep the final
 * geometry, so nothing jumps when the content arrives; they carry no copy.
 */
export function SkeletonGroup({ label = "Loading", className, children }: Readonly<{ label?: string; className?: string; children: ReactNode }>) {
  return <output aria-busy="true" aria-label={label} className={cx("c-skeleton-group", className)}>{children}</output>;
}

/**
 * One placeholder block. A `text` block is one line of its container's text:
 * it is exactly as tall as the line it stands for, so a card, a row or a stat
 * keeps the height of the real thing. Any other block gives its final size.
 */
export function Skeleton({ width = "100%", height = 16, text = false, className }: Readonly<{ width?: number | string; height?: number | string; text?: boolean; className?: string }>) {
  const style: CSSProperties = text ? { width } : { width, height };
  return <span aria-hidden="true" className={cx("c-skeleton", text && "c-skeleton-text", className)} style={style} />;
}
