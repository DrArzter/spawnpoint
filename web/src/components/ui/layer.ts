import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/*
 * One mechanism for every floating layer: tip, menu and toast. A modal
 * dialog or drawer lives in the browser's top layer, and no z-index lifts a
 * page element above it. So each layer is a manual popover, which joins the
 * top layer too, and is shown and hidden only through this file.
 *
 * Without the Popover API (old browsers, jsdom) the layer keeps its fixed
 * position and the `hidden` attribute takes the place of the popover state.
 * Nothing else calls showPopover or hidePopover (test/floating-layers.test.ts).
 */

const supported = (element: HTMLElement) => typeof element.showPopover === "function";

/** Opens the layer. With `raise`, a layer that is already open goes to the front. */
export function showLayer(element: HTMLElement | null, raise = false): void {
  if (!element) return;
  if (!supported(element)) {
    element.hidden = false;
    return;
  }
  if (element.matches(":popover-open")) {
    if (!raise) return;
    element.hidePopover();
  }
  element.showPopover();
}

export function hideLayer(element: HTMLElement | null): void {
  if (!element) return;
  if (!supported(element)) {
    element.hidden = true;
    return;
  }
  if (element.matches(":popover-open")) element.hidePopover();
}

// The top layer stacks in the order of opening. A layer that stays open (the
// toast host) would sit under a dialog opened after it, so a modal's opening
// puts these back in front.
const kept = new Set<HTMLElement>();
let watcher: MutationObserver | null = null;

function keep(element: HTMLElement): () => void {
  kept.add(element);
  if (!watcher && typeof MutationObserver !== "undefined") {
    watcher = new MutationObserver((records) => {
      const modal = records.some((record) => record.target instanceof HTMLDialogElement && record.target.open && record.target.matches(":modal"));
      if (modal) for (const layer of kept) showLayer(layer, true);
    });
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["open"], subtree: true });
  }
  return () => {
    kept.delete(element);
    if (kept.size === 0) {
      watcher?.disconnect();
      watcher = null;
    }
  };
}

/**
 * Shows the element as a layer while `open`. `front` keeps it above any modal
 * that opens later. Declare it before any effect that measures the element.
 */
export function useLayer(ref: RefObject<HTMLElement | null>, open: boolean, front = false): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!open) {
      hideLayer(element);
      return;
    }
    showLayer(element);
    return front ? keep(element) : undefined;
  }, [ref, open, front]);
}

/** Closes an open layer on a press outside it and its anchor; a manual popover has no light dismiss of its own. */
export function useLightDismiss(open: boolean, inside: readonly RefObject<HTMLElement | null>[], onClose: () => void): void {
  const parts = useRef(inside);
  parts.current = inside;
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !parts.current.some((part) => part.current?.contains(target))) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onClose]);
}
