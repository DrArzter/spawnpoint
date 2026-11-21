import type { MouseEvent } from "react";

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

/**
 * Draws one Action. It stays focusable while refused, says why in its tooltip
 * and its accessible name, and a press on it shows the reason instead of
 * running anything.
 */
export function ActionButton({ action, iconOnly = false, ...look }: Readonly<{ action: Action; iconOnly?: boolean } & Look>) {
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
      aria-disabled={refused || undefined}
      aria-label={iconOnly ? action.label : undefined}
      className={buttonClass(look, iconOnly)}
      data-action={action.id}
      data-tip={actionTip(action, iconOnly)}
      onClick={onClick}
      type="button"
    >
      {action.busy ? <ProgressRing className="c-spin" size={18} /> : action.icon && <Icon name={action.icon} size={18} />}
      {!iconOnly && <span>{action.label}</span>}
      {refused && action.hint && <span className="c-sr">, unavailable: {action.hint}</span>}
    </button>
  );
}

/** A link that looks like a button: All worlds, Open, Releases. */
export function LinkButton({ href, label, icon, ...look }: Readonly<{ href: string; label: string; icon?: IconName } & Look>) {
  return (
    <a className={buttonClass(look, false)} href={href}>
      {icon && <Icon name={icon} size={18} />}
      <span>{label}</span>
    </a>
  );
}
