import type { ReactNode } from "react";

import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";

/** A small fact beside a name: Fleet, a role, a desired release, "You". Focusable when it carries a tooltip. */
export function Chip({ icon, tip, className, children }: Readonly<{ icon?: IconName; tip?: string; className?: string; children: ReactNode }>) {
  return (
    <span className={cx("c-chip", className)} data-tip={tip} tabIndex={tip ? 0 : undefined}>
      {icon && <Icon name={icon} size={15} />}
      <span className="c-chip-text">{children}</span>
      {tip && <span className="c-sr">, {tip}</span>}
    </span>
  );
}
