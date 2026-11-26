import { useEffect, useRef, useState } from "react";

import { MOTION, reducedMotion } from "./motion";

export type Staying<T> = Readonly<{ item: T; leaving: boolean }>;
export type Leaving<T> = ReadonlyMap<string, Readonly<{ item: T; index: number }>>;

/**
 * The items leaving after `previous` became `items`: those that dropped out
 * join, at the place they held; those that came back leave the set. `added`
 * says whether one joined, so the caller can start its collapse.
 */
export function nextLeaving<T>(leaving: Leaving<T>, previous: readonly T[], items: readonly T[], keyOf: (item: T) => string): Readonly<{ leaving: Leaving<T>; added: boolean }> {
  const keys = new Set(items.map(keyOf));
  const next = new Map(leaving);
  let added = false;
  previous.forEach((item, index) => {
    const key = keyOf(item);
    if (!keys.has(key) && !next.has(key)) { next.set(key, { item, index }); added = true; }
  });
  for (const key of keys) next.delete(key);
  return { leaving: next, added };
}

/** The stack as drawn: the current items, with each leaving one back at its place. */
export function stackOf<T>(items: readonly T[], leaving: Leaving<T>): Staying<T>[] {
  const out: Staying<T>[] = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of [...leaving.values()].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(index, out.length), 0, { item, leaving: true });
  }
  return out;
}

/**
 * A stack whose items collapse out (A10) instead of vanishing in one frame: an
 * item that leaves the list stays in its place, marked `leaving`, for the
 * collapse's length, so the rest of the stack closes up over it. Each new
 * departure starts its own collapse time. Under reduced motion it goes at once.
 */
export function useLeaving<T>(items: readonly T[], keyOf: (item: T) => string): readonly Staying<T>[] {
  const leaving = useRef<Leaving<T>>(new Map());
  const previous = useRef<readonly T[]>(items);
  const departures = useRef(0);
  const [, redraw] = useState(0);
  if (previous.current !== items) {
    const next = nextLeaving(leaving.current, previous.current, items, keyOf);
    leaving.current = next.leaving;
    if (next.added) departures.current += 1;
    previous.current = items;
  }
  const departure = departures.current;
  useEffect(() => {
    if (departure === 0) return;
    const timer = window.setTimeout(() => { leaving.current = new Map(); redraw((count) => count + 1); }, reducedMotion() ? 0 : MOTION["--c-d2"]);
    return () => window.clearTimeout(timer);
  }, [departure]);
  return stackOf(items, leaving.current);
}

/** Holds a leaving element's height in --c-leave-h, so its collapse starts from where it stands. */
export function holdHeight(element: HTMLElement | null): void {
  element?.style.setProperty("--c-leave-h", `${element.offsetHeight}px`);
}
