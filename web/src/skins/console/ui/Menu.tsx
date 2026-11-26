import { type Align, type Side, positionPopover } from "../../../lib/placement";
import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";

import { hideLayer, showLayer, useLightDismiss } from "../../../components/ui/layer";
import type { Action } from "../../../core/actions";
import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { actionTip } from "./ActionButton";
import { useToast } from "./Toast";
import { t } from "../../../i18n";

/**
 * The item an arrow moves to from item `at`, wrapping at both ends. With focus
 * on the menu itself (`at` is -1, after a pointer open), Down goes to the
 * first item and Up to the last.
 */
export function menuStep(at: number, length: number, step: 1 | -1): number {
  if (at < 0) return step === 1 ? 0 : length - 1;
  return (at + step + length) % length;
}

type Item = Readonly<{ getAttribute: (name: string) => string | null }>;

/**
 * Where focus goes when a menu opens: null for the menu itself (a pointer or
 * touch open, so no item looks chosen), else the index of the chosen radio
 * item, the first enabled item, or the first item.
 */
export function openFocus(keyboard: boolean, items: readonly Item[]): number | null {
  if (!keyboard) return null;
  const checked = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
  if (checked >= 0) return checked;
  const enabled = items.findIndex((item) => item.getAttribute("aria-disabled") !== "true");
  return enabled >= 0 ? enabled : 0;
}

/** `checked` makes the group one choice: its items are radio items and the Action with that id is the chosen one. */
export type MenuGroup = Readonly<{ label?: string; actions: readonly Action[]; checked?: string }>;

// How the last menu was asked for. A menu opened from the keyboard moves focus
// to an item; one opened by pointer or touch focuses the menu itself, so no
// item looks chosen before the person picks one (U2).
let keyboardInput = false;
let tracking = false;
function trackInput() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("keydown", () => { keyboardInput = true; }, true);
  document.addEventListener("pointerdown", () => { keyboardInput = false; }, true);
}

/**
 * A menu of Actions at its anchor's end edge, flipped up when it would leave
 * the viewport. It opens in the top layer (a manual popover), so a transformed
 * page under it cannot move it. Its items stay in the DOM while it is closed,
 * so every Action in it is reachable markup. Arrows move, Escape and Tab close it, and focus
 * goes back to the anchor. A keyboard open focuses the chosen radio item, else
 * the first enabled item.
 */
/**
 * `side` and `align` place the menu against its anchor through the shared
 * placement: below and lined up with the anchor's end by default, a leading
 * trigger lines up with its start.
 */
export function Menu({ id, label, groups, open, anchor, onClose, side = "bottom", align = "end" }: Readonly<{
  id: string; label: string; groups: readonly MenuGroup[]; open: boolean; anchor: RefObject<HTMLElement | null>; onClose: () => void;
  side?: Side; align?: Align;
}>) {
  const menu = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];

  useLayoutEffect(trackInput, []);
  useLayoutEffect(() => {
    const element = menu.current;
    const target = anchor.current;
    if (!element) return;
    if (!open || !target) {
      hideLayer(element);
      return;
    }
    showLayer(element);
    positionPopover(element, target, side, align);
    const list = items();
    const first = openFocus(keyboardInput, list);
    (first === null ? element : list[first])?.focus();
  }, [open, anchor, side, align]);

  useLightDismiss(open, [menu, anchor], onClose);

  const close = () => { onClose(); anchor.current?.focus(); };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[menuStep(at, list.length, event.key === "ArrowDown" ? 1 : -1)]?.focus();
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
    <div aria-label={label} className="c-menu c-popover" data-layer="menu" id={id} popover="manual" onKeyDown={onKey} ref={menu} role="menu" tabIndex={-1} /* NOSONAR focus moves to the items, which carry the tab stop */>
      {visible.map((group, index) => (
        <div className={cx("c-menu-group", index > 0 && "c-menu-group-split")} key={group.label ?? index} role="group" aria-label={group.label} /* NOSONAR a labelled group of menu items; <fieldset> is not valid inside a menu */>
          {group.label && <div aria-hidden="true" className="c-menu-label">{group.label}</div>}
          {group.actions.map((action) => {
            const radio = group.checked !== undefined;
            const checked = action.id === group.checked;
            return (
            <button
              aria-checked={radio ? checked : undefined}
              aria-disabled={action.disabled || undefined}
              className={cx("c-menu-item", action.danger && "c-menu-item-danger")}
              data-action={action.id}
              data-tip={action.disabled ? actionTip(action) : undefined}
              key={`${action.id}:${action.label}`}
              onClick={() => run(action)}
              role={radio ? "menuitemradio" : "menuitem"}
              tabIndex={-1}
              type="button"
            >
              {radio ? <Icon name={checked ? "check_circle" : "radio_button_unchecked"} size={20} /> : action.icon && <Icon name={action.icon} size={20} />}
              <span className="c-menu-text">{action.label}</span>
              {action.detail && <span className="c-menu-end">{action.detail}</span>}
              {action.disabled && action.hint && <span className="c-sr">{t("ui.unavailableBecause", { reason: action.hint })}</span>}
            </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
