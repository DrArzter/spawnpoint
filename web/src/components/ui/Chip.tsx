import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";

export type ChipTone = "outlined" | "tonal" | "primary" | "success" | "warning" | "error";

export function Chip({ children, icon, tone = "outlined", className }: { children: ReactNode; icon?: IconName; tone?: ChipTone; className?: string }) {
  return (
    <span className={cx("chip", tone !== "outlined" && `chip-${tone}`, className)}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  );
}

export function ChoiceChip({ children, icon, pressed, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; pressed: boolean }) {
  return (
    <button aria-pressed={pressed} className={cx("chip", className)} type={type} {...props}>
      {pressed ? <Icon name="check" size={16} /> : icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}
