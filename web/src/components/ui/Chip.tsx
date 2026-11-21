import type { ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

export type ChipTone = "outlined" | "tonal";

export function Chip({ children, icon, tone = "outlined", className }: Readonly<{ children: ReactNode; icon?: IconName; tone?: ChipTone; className?: string }>) {
  return (
    <span className={cx("chip", tone !== "outlined" && `chip-${tone}`, className)}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  );
}
