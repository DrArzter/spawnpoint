import type { ReactNode } from "react";

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
        {detail && <span className="c-stat-detail">{detail}</span>}
      </div>
      <div className="c-stat-value">
        {value === null ? <span className="c-faint">—</span> : <>{value}{unit && <span className="c-stat-unit">{unit}</span>}</>}
      </div>
      {children}
    </section>
  );
}
