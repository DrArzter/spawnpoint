import { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ children, className = "", icon, variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  variant?: ButtonVariant;
}) {
  return <button className={`ui-button ui-button-${variant} ${className}`.trim()} {...props}>{icon}{children}</button>;
}
