import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** The narrowest a dragged panel gets, and the strip of page it always leaves in view. */
export const PANEL_MIN_WIDTH = 400;
export const PANEL_PAGE_STRIP = 48;
const KEY_STEP = 32;

const storageKey = (key: string) => `spawnpoint.panel-width.${key}`;

function stored(key: string): number | null {
  try {
    const value = Number(globalThis.localStorage?.getItem(storageKey(key)));
    return Number.isFinite(value) && value >= PANEL_MIN_WIDTH ? value : null;
  } catch {
    return null;
  }
}

function store(key: string, width: number | null) {
  try {
    if (width === null) globalThis.localStorage?.removeItem(storageKey(key));
    else globalThis.localStorage?.setItem(storageKey(key), String(Math.round(width)));
  } catch {
    // A private window keeps the width for this visit only.
  }
}

/** The widest a panel may be on this screen. */
export const panelMaxWidth = (viewport: number) => Math.max(PANEL_MIN_WIDTH, viewport - PANEL_PAGE_STRIP);

export const clampPanelWidth = (width: number, viewport: number) => Math.min(Math.max(width, PANEL_MIN_WIDTH), panelMaxWidth(viewport));

/**
 * A side panel's width that the person drags from its start edge, or sets
 * with the arrow keys, remembered per panel in this browser. Null keeps the
 * panel's own width; a double click goes back to it.
 */
export function usePanelWidth(key: string | undefined) {
  const [width, setWidth] = useState<number | null>(() => (key === undefined ? null : stored(key)));
  const [dragging, setDragging] = useState(false);
  const latest = useRef(width);
  latest.current = width;
  const [viewport, setViewport] = useState(() => globalThis.innerWidth ?? 1280);

  useEffect(() => {
    const resize = () => setViewport(globalThis.innerWidth);
    globalThis.addEventListener?.("resize", resize);
    return () => globalThis.removeEventListener?.("resize", resize);
  }, []);

  const commit = useCallback((next: number | null) => {
    setWidth(next);
    if (key !== undefined) store(key, next);
  }, [key]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    setDragging(true);
    // The drag keeps its own last width, so a release before the next render still stores it.
    let last: number | null = null;
    const move = (moved: globalThis.PointerEvent) => {
      last = clampPanelWidth(globalThis.innerWidth - moved.clientX, globalThis.innerWidth);
      setWidth(last);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      setDragging(false);
      if (key !== undefined && last !== null) store(key, last);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }, [key]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const panel = event.currentTarget.parentElement;
    const current = latest.current ?? panel?.getBoundingClientRect().width ?? PANEL_MIN_WIDTH;
    const max = panelMaxWidth(globalThis.innerWidth);
    // The panel sits at the end edge, so the start edge moving left widens it.
    const next = ({ ArrowLeft: current + KEY_STEP, ArrowRight: current - KEY_STEP, Home: max, End: PANEL_MIN_WIDTH } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commit(clampPanelWidth(next, globalThis.innerWidth));
  }, [commit]);

  const shown = width === null ? null : clampPanelWidth(width, viewport);
  return { width: shown, dragging, max: panelMaxWidth(viewport), onPointerDown, onKeyDown, reset: () => commit(null) };
}
