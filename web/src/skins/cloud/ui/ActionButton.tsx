import { forwardRef, type MouseEvent } from "react";

import type { Action } from "../../../core/actions";
import { Icon, ProgressRing, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { useToast } from "./Toast";

export type ButtonVariant = "primary" | "default" | "danger" | "ghost";
export type ButtonSize = "md" | "sm";

type Look = Readonly<{ variant?: ButtonVariant; size?: ButtonSize; className?: string }>;

function buttonClass({ variant = "default", size = "md", className }: Look, iconOnly: boolean): string {
  return cx("c-btn", `c-btn-${variant}`, size === "sm" && "c-btn-sm", iconOnly && "c-btn-icon", className);
}

/** The tooltip a control shows: why it is refused, else what it does when the label is hidden. */
export function actionTip(action: Action, iconOnly = false): string | undefined {
  if (action.disabled && action.hint) return action.hint;
  return iconOnly ? action.hint ?? action.label : action.hint;
}

/** Props a button takes when it opens a menu: the menu's id and whether it is open. */
export type MenuTrigger = Readonly<{ id: string; expanded: boolean }>;

/**
 * Draws one Action. It stays focusable while refused, says why in its tooltip
 * and its accessible name, and a press on it shows the reason instead of
 * running anything. `name` replaces the accessible name where the label alone
 * is ambiguous ("Remove Mira" for a row's Remove); `menu` marks a button that
 * opens a menu.
 */
export const ActionButton = forwardRef<HTMLButtonElement, Readonly<{ action: Action; iconOnly?: boolean; name?: string; menu?: MenuTrigger } & Look>>(
  function ActionButton({ action, iconOnly = false, name, menu, ...look }, ref) {
    const toast = useToast();
    const refused = action.disabled === true;
    const onClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (refused) {
        if (action.hint) toast(action.hint, "why");
        return;
      }
      if (!action.busy) action.run();
    };
    return (
      <button
        aria-busy={action.busy || undefined}
        aria-controls={menu?.id}
        aria-disabled={refused || undefined}
        aria-expanded={menu ? menu.expanded : undefined}
        aria-haspopup={menu ? "menu" : undefined}
        aria-label={name ?? (iconOnly ? action.label : undefined)}
        className={buttonClass(look, iconOnly)}
        data-action={action.id}
        data-tip={actionTip(action, iconOnly)}
        onClick={onClick}
        ref={ref}
        type="button"
      >
        {action.busy ? <ProgressRing className="c-spin" size={18} /> : action.icon && <Icon name={action.icon} size={18} />}
        {!iconOnly && <span>{action.label}</span>}
        {menu && !iconOnly && <Icon className="c-btn-caret" name="expand_more" size={18} />}
        {refused && action.hint && <span className="c-sr">, unavailable: {action.hint}</span>}
      </button>
    );
  },
);

/** A link that looks like a button: All worlds, Open, Releases. `iconOnly` keeps the label as its name and tooltip. */
export function LinkButton({ href, label, icon, iconOnly = false, ...look }: Readonly<{ href: string; label: string; icon?: IconName; iconOnly?: boolean } & Look>) {
  return (
    <a aria-label={iconOnly ? label : undefined} className={buttonClass(look, iconOnly)} data-tip={iconOnly ? label : undefined} href={href}>
      {icon && <Icon name={icon} size={18} />}
      {!iconOnly && <span>{label}</span>}
    </a>
  );
}
