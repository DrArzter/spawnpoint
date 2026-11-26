import { useEffect, useRef, useState } from "react";

import { MOTION, reducedMotion } from "./motion";

export type Staying<T> = Readonly<{ item: T; leaving: boolean }>;

/**
 * A stack whose items collapse out (A10) instead of vanishing in one frame: an
 * item that leaves the list stays in its place, marked `leaving`, for the
 * collapse's length, so the rest of the stack closes up over it. Under
 * reduced motion it goes at once.
 */
export function useLeaving<T>(items: readonly T[], keyOf: (item: T) => string): readonly Staying<T>[] {
  const leaving = useRef(new Map<string, Readonly<{ item: T; index: number }>>());
  const previous = useRef<readonly T[]>(items);
  const [, redraw] = useState(0);
  if (previous.current !== items) {
    const keys = new Set(items.map(keyOf));
    previous.current.forEach((item, index) => {
      const key = keyOf(item);
      if (!keys.has(key) && !leaving.current.has(key)) leaving.current.set(key, { item, index });
    });
    for (const key of keys) leaving.current.delete(key);
    previous.current = items;
  }
  const pending = leaving.current.size;
  useEffect(() => {
    if (pending === 0) return;
    const timer = window.setTimeout(() => { leaving.current.clear(); redraw((count) => count + 1); }, reducedMotion() ? 0 : MOTION["--c-d2"]);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const out: Staying<T>[] = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of [...leaving.current.values()].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(index, out.length), 0, { item, leaving: true });
  }
  return out;
}

/** Holds a leaving element's height in --c-leave-h, so its collapse starts from where it stands. */
export function holdHeight(element: HTMLElement | null): void {
  element?.style.setProperty("--c-leave-h", `${element.offsetHeight}px`);
}
