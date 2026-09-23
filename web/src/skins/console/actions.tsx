import type { ButtonHTMLAttributes } from "react";

import { Button, type ButtonVariant } from "../../components/ui/Button";
import type { MenuItem } from "../../components/ui/Menu";
import { Tooltip } from "../../components/ui/Tooltip";
import type { Action } from "../../core/actions";

/*
 * How this skin draws an action. Every control carries `data-action` with the
 * action's id: that attribute is what the skin contract test looks for, and
 * what a future skin has to reproduce however it draws the same verb.
 */

export function ActionButton({ action, variant = "outlined", size, className, hideIcon = false, tooltipWhenDisabled = false, ...rest }: Readonly<{
  action: Action;
  variant?: ButtonVariant;
  size?: "small" | "medium";
  className?: string;
  hideIcon?: boolean;
  /** A disabled button answers no hover on a touch screen, so its reason needs a reachable home. */
  tooltipWhenDisabled?: boolean;
}> & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "children">) {
  const button = (
    <Button
      aria-label={action.hint && action.disabled ? `${action.label}. ${action.hint}` : undefined}
      className={className}
      data-action={action.id}
      disabled={action.disabled}
      icon={hideIcon ? undefined : action.icon}
      loading={action.busy}
      onClick={action.run}
      size={size}
      title={action.disabled ? undefined : action.hint}
      variant={action.danger && variant === "filled" ? "danger" : variant}
      {...rest}
    >
      {action.label}
    </Button>
  );
  return tooltipWhenDisabled && action.disabled && action.hint ? <Tooltip text={action.hint}>{button}</Tooltip> : button;
}

export function menuItems(actions: readonly Action[]): MenuItem[] {
  return actions.map((action) => ({
    id: action.id,
    actionId: action.id,
    label: action.label,
    detail: action.detail,
    icon: action.icon,
    danger: action.danger,
    disabled: action.disabled,
    title: action.hint,
    onSelect: action.run,
  }));
}

/** Menu items with a separator between two groups, when both have members. */
export function menuGroups(...groups: readonly (readonly Action[])[]): (MenuItem | "separator")[] {
  return groups.filter((group) => group.length > 0).flatMap((group, index) => (index === 0 ? menuItems(group) : ["separator" as const, ...menuItems(group)]));
}
