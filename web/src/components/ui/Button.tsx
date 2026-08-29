import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  variant?: ButtonVariant;
}>(function Button({ children, className = "", icon, variant = "secondary", ...props }, ref) {
  return <button className={`ui-button ui-button-${variant} ${className}`.trim()} ref={ref} {...props}>{icon}{children}</button>;
});
