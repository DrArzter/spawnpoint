import { cx } from "../../lib/cx";

export function Skeleton({ width = "100%", height = 14, className }: Readonly<{ width?: string; height?: number; className?: string }>) {
  return <span aria-hidden="true" className={cx("skeleton", className)} style={{ width, height }} />;
}
