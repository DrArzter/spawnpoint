import type { ButtonHTMLAttributes, Ref } from "react";

import { Icon, IconName, ProgressRing } from "../../icons";
import { cx } from "../../lib/cx";

export type ButtonVariant = "text" | "outlined" | "filled" | "danger" | "danger-text";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  loading?: boolean;
  size?: "small" | "medium";
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
};

export function Button({ children, className, icon, loading = false, size = "medium", variant = "outlined", disabled, ref, type = "button", ...props }: ButtonProps) {
  return (
    <button
      aria-busy={loading || undefined}
      className={cx("btn", `btn-${variant}`, size === "small" && "btn-small", className)}
      disabled={disabled || loading}
      ref={ref}
      type={type}
      {...props}
    >
      {loading && <ProgressRing size={18} />}
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: IconName;
  size?: "small" | "medium";
  ref?: Ref<HTMLButtonElement>;
};

// Every icon button carries its name: aria-label for readers, title for pointers.
export function IconButton({ label, icon, size = "medium", className, ref, type = "button", ...props }: IconButtonProps) {
  return (
    <button aria-label={label} className={cx("icon-btn", size === "small" && "icon-btn-small", className)} ref={ref} title={label} type={type} {...props}>
      <Icon name={icon} size={size === "small" ? 18 : 22} />
    </button>
  );
}
