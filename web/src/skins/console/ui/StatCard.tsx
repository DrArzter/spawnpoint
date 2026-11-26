import type { ReactNode } from "react";

import { Skeleton } from "./Skeleton";

/**
 * A measured value: its label, a detail line (a peak and its time, an
 * average), and the value with its unit at the foot, where every card of a row
 * draws it at one height (G6). `—` when the value is not known. `tip` says the
 * value another way, as its tooltip: "65 % of host".
 */
export function StatCard({ label, value, unit, tip, detail, children }: Readonly<{ label: string; value: string | null; unit?: string; tip?: string; detail?: ReactNode; children?: ReactNode }>) {
  const hint = value === null ? undefined : tip;
  return (
    <section aria-label={label} className="c-card c-stat">
      <div className="c-stat-head">
        <span className="c-stat-label">{label}</span>
        {detail && <span className="c-stat-detail" data-tip={typeof detail === "string" ? detail : undefined}>{detail}</span>}
      </div>
      <div className="c-stat-value" data-tip={hint} tabIndex={hint ? 0 : undefined /* NOSONAR focusable tooltip trigger */}>
        {value === null ? <span className="c-faint">—</span> : <>{value}{unit && <span className="c-stat-unit">{unit}</span>}</>}
      </div>
      {children}
    </section>
  );
}

/**
 * A stat that is still loading, on the same shell: a label, the two parts of
 * its detail (which wrap as the real ones do) and the value with its unit,
 * each one line.
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
