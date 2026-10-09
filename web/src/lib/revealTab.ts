import { useEffect, type RefObject } from "react";

type Span = Readonly<{ left: number; right: number }>;

/** How far a strip scrolls sideways so the tab is wholly inside it; 0 when it is. */
export function revealDelta(strip: Span, tab: Span): number {
  if (tab.left < strip.left) return tab.left - strip.left;
  if (tab.right > strip.right) return Math.min(tab.right - strip.right, tab.left - strip.left);
  return 0;
}

// A tab strip scrolls sideways on a narrow screen, so the selected tab can sit
// past its edge, out of sight. Only the strip moves; the page never scrolls.
export function useRevealSelectedTab(strip: RefObject<HTMLElement | null>, value: string): void {
  useEffect(() => {
    const list = strip.current;
    const tab = list?.querySelector<HTMLElement>("[role=tab][aria-selected=true]");
    if (!list || !tab) return;
    const delta = revealDelta(list.getBoundingClientRect(), tab.getBoundingClientRect());
    if (delta !== 0) list.scrollLeft += delta;
  }, [strip, value]);
}
