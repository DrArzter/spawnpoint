import type { CSSProperties, ReactNode } from "react";

import { cx } from "../../../lib/cx";

/**
 * One announced loading region. Placeholders inside it keep the final
 * geometry, so nothing jumps when the content arrives; they carry no copy.
 */
export function SkeletonGroup({ label = "Loading", className, children }: Readonly<{ label?: string; className?: string; children: ReactNode }>) {
  return <div aria-busy="true" aria-label={label} className={cx("c-skeleton-group", className)} role="status">{children}</div>;
}

/** One placeholder block. Width and height are its final size. */
export function Skeleton({ width = "100%", height = 16, className }: Readonly<{ width?: number | string; height?: number | string; className?: string }>) {
  const style: CSSProperties = { width, height };
  return <span aria-hidden="true" className={cx("c-skeleton", className)} style={style} />;
}
