import type { ReactNode } from "react";

import { Skeleton } from "./Skeleton";

/**
 * A measured value: its label, the value with its unit, and one line at the
 * end (a peak and its time, an average). `—` when the value is not known.
 * S5 fills it from the metrics model.
 */
export function StatCard({ label, value, unit, detail, children }: Readonly<{ label: string; value: string | null; unit?: string; detail?: ReactNode; children?: ReactNode }>) {
  return (
    <section aria-label={label} className="c-card c-stat">
      <div className="c-stat-head">
        <span className="c-stat-label">{label}</span>
        {detail && <span className="c-stat-detail" data-tip={typeof detail === "string" ? detail : undefined}>{detail}</span>}
      </div>
      <div className="c-stat-value">
        {value === null ? <span className="c-faint">—</span> : <>{value}{unit && <span className="c-stat-unit">{unit}</span>}</>}
      </div>
      {children}
    </section>
  );
}

/**
 * A stat that is still loading, on the same shell: a label, the two parts of
 * its detail (which wrap as the real ones do) and the value, each one line.
 */
export function StatSkeleton() {
  return (
    <section className="c-card c-stat">
      <div className="c-stat-head">
        <span className="c-stat-label"><Skeleton text width="40%" /></span>
        <span className="c-stat-detail"><Skeleton text width="10em" /><Skeleton text width="5.5em" /></span>
      </div>
      <div className="c-stat-value"><Skeleton text width="45%" /></div>
    </section>
  );
}
