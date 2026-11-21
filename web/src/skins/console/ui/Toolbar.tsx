import type { ReactNode } from "react";

import { cx } from "../../../lib/cx";

/** A row of controls above a list: what narrows it at the start, what acts on it at the end edge. */
export function Toolbar({ start, end, label, className }: Readonly<{ start?: ReactNode; end?: ReactNode; label?: string; className?: string }>) {
  return (
    <div aria-label={label} className={cx("c-toolbar", className)} data-layout="spread" role={label ? "toolbar" : undefined}>
      {start && <div className="c-toolbar-start">{start}</div>}
      {end && <div className="c-toolbar-end">{end}</div>}
    </div>
  );
}
