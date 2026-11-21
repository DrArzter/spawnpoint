import { forwardRef, type ButtonHTMLAttributes } from "react";

import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";

/** A round icon control that is not a model Action: Close, Dismiss, Search. Its label is its name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, Readonly<{ icon: IconName; label: string; tone?: "page" | "band" | "flash" } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">>>(
  function IconButton({ icon, label, tone = "page", className, ...rest }, ref) {
    return (
      <button aria-label={label} className={cx("c-icon-btn", tone !== "page" && `c-icon-btn-${tone}`, className)} data-tip={label} ref={ref} type="button" {...rest}>
        <Icon name={icon} size={20} />
      </button>
    );
  },
);
