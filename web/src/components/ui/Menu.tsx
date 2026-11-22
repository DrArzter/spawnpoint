import { useId, useRef, useState, type KeyboardEvent } from "react";

import { Icon, IconName } from "../../icons";
import { Avatar } from "../Avatar";
import { IconButton } from "./Button";
import { hideLayer, showLayer, useLightDismiss } from "./layer";

export type MenuItem = {
  id: string;
  /** The action this item runs, so a skin's menus satisfy the contract like its buttons. */
  actionId?: string;
  label: string;
  detail?: string;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
};

// Overflow menu in the top layer (a manual popover), so table scroll
// containers never clip it; positioned from the trigger's rectangle on open.
// A press outside closes it (the popover has no light dismiss of its own).
export function Menu({ label, icon = "more_vert", items, align = "end", size = "medium", avatar }: Readonly<{
  label: string;
  icon?: IconName;
  items: readonly (MenuItem | "separator")[];
  align?: "start" | "end";
  size?: "small" | "medium";
  avatar?: { name: string; photoUrl?: string | null };
}>) {
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
    showLayer(menu);
    setOpen(true);
    window.requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus());
  }

  function hide() {
    hideLayer(panel.current);
    setOpen(false);
  }

  useLightDismiss(open, [panel, trigger], hide);

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
      {!avatar && <IconButton aria-controls={id} aria-expanded={open} aria-haspopup="menu" icon={icon} label={label} onClick={() => (open ? hide() : show())} ref={trigger} size={size} />}
      <div className="menu" data-layer="menu" data-open={open || undefined} id={id} onKeyDown={onKeyDown} popover="manual" ref={panel} role="menu" /* NOSONAR focus moves to the items, which carry the tab stop */>
        {items.map((item, index) => item === "separator" ? <hr key={`separator-${index}`} /> : ( // NOSONAR separators have no id; the list is rebuilt whole
          <button
            className="menu-item"
            data-action={item.actionId}
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
