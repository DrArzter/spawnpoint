import type { ButtonHTMLAttributes } from "react";

import { Button, IconButton, type ButtonVariant } from "../../components/ui/Button";
import { Menu, type MenuItem } from "../../components/ui/Menu";
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

/** An action drawn as its icon alone; its name is the button's label and tooltip. */
export function ActionIconButton({ action, size = "medium" }: Readonly<{ action: Action & { icon: NonNullable<Action["icon"]> }; size?: "small" | "medium" }>) {
  return (
    <IconButton
      data-action={action.id}
      disabled={action.disabled || action.busy}
      icon={action.icon}
      label={action.hint && action.disabled ? `${action.label}. ${action.hint}` : action.label}
      onClick={action.run}
      size={size}
    />
  );
}

/**
 * Actions that do not earn a button of their own. Two or more share a menu;
 * one is drawn as its icon, because a menu that holds one item only hides it
 * behind a second tap. An action without an icon keeps the menu.
 */
export function ActionOverflow({ groups, label, size = "medium" }: Readonly<{ groups: readonly (readonly Action[])[]; label: string; size?: "small" | "medium" }>) {
  const actions = groups.flat();
  const only = actions.length === 1 ? actions[0] : undefined;
  if (actions.length === 0) return null;
  if (only?.icon) return <ActionIconButton action={{ ...only, icon: only.icon }} size={size} />;
  return <Menu align="end" items={menuGroups(...groups)} label={label} size={size} />;
}
