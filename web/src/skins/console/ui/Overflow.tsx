import { useCallback, useId, useRef, useState } from "react";

import type { Action } from "../../../core/actions";
import { Icon } from "../../../icons";
import { Avatar, type AvatarSize } from "./Avatar";
import { IconButton } from "./IconButton";
import { Menu, type MenuGroup } from "./Menu";

/**
 * The row and page "more" menu. Danger Actions go to a group of their own at
 * the end, under a rule, so a destructive item never sits between two safe ones.
 */
/**
 * `avatar` makes the person's picture the trigger, with an edit badge on hover
 * and focus, for the menu that changes that picture.
 */
export function Overflow({ actions, groups, label, size = "md", avatar }: Readonly<{
  actions?: readonly Action[]; groups?: readonly MenuGroup[]; label: string; size?: "md" | "sm";
  avatar?: Readonly<{ name: string; photoUrl?: string | null; size: AvatarSize }>;
}>) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const all = groups ?? splitDanger(actions ?? []);
  if (all.every((group) => group.actions.length === 0)) return null;
  return (
    <span className="c-overflow">
      {avatar
        ? (
          <button aria-controls={id} aria-expanded={open} aria-haspopup="menu" aria-label={label} className="c-avatar-trigger" onClick={() => setOpen((value) => !value)} ref={anchor} type="button">
            <Avatar name={avatar.name} photoUrl={avatar.photoUrl} size={avatar.size} />
            <span aria-hidden="true" className="c-avatar-badge" data-layer="glyph"><Icon name="edit" size={14} /></span>
          </button>
        )
        : (
          <IconButton
            aria-controls={id}
            aria-expanded={open}
            aria-haspopup="menu"
            className={size === "sm" ? "c-icon-btn-sm" : undefined}
            icon="more_vert"
            label={label}
            onClick={() => setOpen((value) => !value)}
            ref={anchor}
          />
        )}
      <Menu align={avatar ? "start" : "end"} anchor={anchor} groups={all} id={id} label={label} onClose={close} open={open} />
    </span>
  );
}

function splitDanger(actions: readonly Action[]): MenuGroup[] {
  return [{ actions: actions.filter((item) => !item.danger) }, { actions: actions.filter((item) => item.danger) }];
}
