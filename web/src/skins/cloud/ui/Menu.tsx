import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";

import type { Action } from "../../../core/actions";
import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { actionTip } from "./ActionButton";
import { useToast } from "./Toast";

export type MenuGroup = Readonly<{ label?: string; actions: readonly Action[] }>;

/**
 * A menu of Actions at its anchor's end edge, flipped up when it would leave
 * the viewport. Its items stay in the DOM while it is closed, so every Action
 * in it is reachable markup. Arrows move, Escape and Tab close it, and focus
 * goes back to the anchor.
 */
export function Menu({ id, label, groups, open, anchor, onClose }: Readonly<{ id: string; label: string; groups: readonly MenuGroup[]; open: boolean; anchor: RefObject<HTMLElement | null>; onClose: () => void }>) {
  const menu = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];

  useLayoutEffect(() => {
    const element = menu.current;
    const target = anchor.current;
    if (!open || !element || !target) return;
    const rect = target.getBoundingClientRect();
    const height = element.offsetHeight;
    const width = element.offsetWidth;
    const below = rect.bottom + 4 + height <= window.innerHeight || rect.top - 4 - height < 0;
    element.style.top = `${below ? rect.bottom + 4 : rect.top - 4 - height}px`;
    element.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    (items().find((item) => item.getAttribute("aria-disabled") !== "true") ?? items()[0])?.focus();
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, anchor, onClose]);

  const close = () => { onClose(); anchor.current?.focus(); };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(at + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close();
    }
  };
  const run = (action: Action) => {
    if (action.disabled) {
      if (action.hint) toast(action.hint, "why");
      return;
    }
    close();
    action.run();
  };
  const visible = groups.filter((group) => group.actions.length > 0);

  return (
    <div aria-label={label} className="c-menu" data-layer="menu" hidden={!open} id={id} onKeyDown={onKey} ref={menu} role="menu">
      {visible.map((group, index) => (
        <div className={cx("c-menu-group", index > 0 && "c-menu-group-split")} key={group.label ?? index} role="group" aria-label={group.label}>
          {group.label && <div aria-hidden="true" className="c-menu-label">{group.label}</div>}
          {group.actions.map((action) => (
            <button
              aria-disabled={action.disabled || undefined}
              className={cx("c-menu-item", action.danger && "c-menu-item-danger")}
              data-action={action.id}
              data-tip={action.disabled ? actionTip(action) : undefined}
              key={`${action.id}:${action.label}`}
              onClick={() => run(action)}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              {action.icon && <Icon name={action.icon} size={20} />}
              <span>{action.label}</span>
              {action.detail && <span className="c-menu-end">{action.detail}</span>}
              {action.disabled && action.hint && <span className="c-sr">, unavailable: {action.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
