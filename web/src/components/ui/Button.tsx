import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  loading?: boolean;
  size?: "small" | "medium";
  variant?: ButtonVariant;
}>(function Button({ children, className = "", icon, loading = false, size = "medium", variant = "secondary", disabled, ...props }, ref) {
  return <button aria-busy={loading || undefined} className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()} disabled={disabled || loading} ref={ref} {...props}>{loading && <span aria-hidden="true" className="ui-button-progress" />}{!loading && icon}{children}</button>;
});
