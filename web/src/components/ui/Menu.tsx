import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { Icon, IconName } from "../../icons";
import { cx } from "../../lib/cx";
import { Avatar } from "../Avatar";
import { IconButton } from "./Button";

export type MenuItem = {
  id: string;
  label: string;
  detail?: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
};

// Overflow menu in the top layer (popover API), so table scroll containers
// never clip it; positioned from the trigger's rectangle on open.
export function Menu({ label, icon = "more_vert", items, align = "end", size = "medium", avatar, chip }: {
  label: string;
  icon?: IconName;
  items: readonly (MenuItem | "separator")[];
  align?: "start" | "end";
  size?: "small" | "medium";
  avatar?: { name: string; photoUrl?: string | null };
  chip?: { label: string; icon: IconName; className: string };
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  function show() {
    const button = trigger.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = 224;
    const left = align === "end" ? Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) : Math.min(rect.left, window.innerWidth - width - 8);
    const below = rect.bottom + 4;
    const estimatedHeight = 16 + items.length * 44;
    menu.style.left = `${left}px`;
    menu.style.top = below + estimatedHeight > window.innerHeight ? `${Math.max(8, rect.top - estimatedHeight - 4)}px` : `${below}px`;
    menu.style.width = `${width}px`;
    if (typeof menu.showPopover === "function") menu.showPopover();
    setOpen(true);
    window.requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
  }

  function hide() {
    const menu = panel.current;
    if (menu && typeof menu.hidePopover === "function" && menu.matches(":popover-open")) menu.hidePopover();
    setOpen(false);
  }

  useEffect(() => {
    const menu = panel.current;
    if (!menu) return;
    const onToggle = (event: Event) => {
      const state = (event as ToggleEvent).newState;
      if (state === "closed") setOpen(false);
    };
    menu.addEventListener("toggle", onToggle);
    return () => menu.removeEventListener("toggle", onToggle);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
    const index = focusable.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + focusable.length) % focusable.length;
      focusable[next]?.focus();
    }
    if (event.key === "Escape" || event.key === "Tab") {
      hide();
      trigger.current?.focus();
    }
  }

  return (
    <>
      {avatar && <button aria-controls={id} aria-expanded={open} aria-haspopup="menu" aria-label={label} className="appbar-avatar" onClick={() => (open ? hide() : show())} ref={trigger} title={label} type="button"><Avatar name={avatar.name} photoUrl={avatar.photoUrl} /></button>}
      {chip && <button aria-controls={id} aria-expanded={open} aria-haspopup="menu" className={chip.className} onClick={() => (open ? hide() : show())} ref={trigger} title={label} type="button"><Icon name={chip.icon} size={14} /><span>{chip.label}</span><Icon name="expand_more" size={14} /></button>}
      {!avatar && !chip && <IconButton aria-controls={id} aria-expanded={open} aria-haspopup="menu" icon={icon} label={label} onClick={() => (open ? hide() : show())} ref={trigger} size={size} />}
      <div className="menu" data-open={open || undefined} id={id} onKeyDown={onKeyDown} popover="auto" ref={panel} role="menu">
        {items.map((item, index) => item === "separator" ? <hr key={`separator-${index}`} /> : (
          <button
            className={cx("menu-item", item.danger && "menu-item-danger")}
            disabled={item.disabled}
            key={item.id}
            onClick={() => { hide(); item.onSelect(); }}
            role="menuitem"
            title={item.title}
            type="button"
          >
            {item.icon && <Icon name={item.icon} size={20} />}
            <span>{item.label}{item.detail && <small>{item.detail}</small>}</span>
          </button>
        ))}
      </div>
    </>
  );
}
