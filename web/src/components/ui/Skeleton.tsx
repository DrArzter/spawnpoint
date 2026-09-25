import { cx } from "../../lib/cx";

export function Skeleton({ width = "100%", height = 14, className }: { width?: string; height?: number; className?: string }) {
  return <span aria-hidden="true" className={cx("skeleton", className)} style={{ width, height }} />;
}

export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="skeleton-rows" role="status" style={{ display: "grid", gap: 14, padding: "16px 20px" }}>
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} style={{ display: "grid", gridTemplateColumns: "2fr 3fr 1fr", gap: 24 }}>
          <Skeleton width={`${60 + ((index * 23) % 40)}%`} />
          <Skeleton width={`${40 + ((index * 31) % 50)}%`} />
          <Skeleton width="70%" />
        </span>
      ))}
    </div>
  );
}
