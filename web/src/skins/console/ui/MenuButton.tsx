import { useCallback, useId, useRef, useState } from "react";

import { action } from "../../../core/actions";
import type { IconName } from "../../../icons";
import { ActionButton, type ButtonSize, type ButtonVariant } from "./ActionButton";
import { Menu, type MenuGroup } from "./Menu";

/**
 * A labelled button that opens a menu of Actions: bulk Actions on a table,
 * "More" in a header. Use Overflow for the icon-only "more" menu.
 */
export function MenuButton({ id, label, icon, groups, variant = "default", size = "md", disabled = false, hint }: Readonly<{
  /** Stable data-action id of the trigger itself. */
  id: string;
  label: string;
  icon?: IconName;
  groups: readonly MenuGroup[];
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The trigger is refused as a whole (nothing selected), with the reason as its hint. */
  disabled?: boolean;
  hint?: string;
}>) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="c-overflow">
      <ActionButton
        action={action(id, label, () => setOpen((value) => !value), { disabled, hint, ...(icon ? { icon } : {}) })}
        menu={{ id: menuId, expanded: open }}
        ref={anchor}
        size={size}
        variant={variant}
      />
      <Menu anchor={anchor} groups={groups} id={menuId} label={label} onClose={close} open={open} />
    </span>
  );
}
