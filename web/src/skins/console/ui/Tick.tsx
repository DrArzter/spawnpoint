import { useEffect, useRef, useState } from "react";

import { cx } from "../../../lib/cx";
import { MOTION, reducedMotion } from "./motion";

/*
 * The two motions that react to a value, not to a navigation: a number that
 * changed counts to its new value (A8), and a row that was not there before
 * arrives (A9). Neither runs on the first render of a view, and both are
 * instant under reduced motion.
 */

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The number to show while `value` counts from its last value to the new one, and whether it is counting. */
export function useTick(value: number | null): Readonly<{ shown: number | null; ticking: boolean }> {
  const [shown, setShown] = useState(value);
  const [ticking, setTicking] = useState(false);
  const last = useRef(value);
  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value) return;
    if (from === null || value === null || reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const length = MOTION["--c-d-tick"];
    let frame = 0;
    setTicking(true);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / length);
      setShown(Math.round(from + (value - from) * easeOut(t)));
      if (t < 1) frame = requestAnimationFrame(step);
      else setTicking(false);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return { shown, ticking };
}

/** A count that ticks to a new value with a short lift in the accent (A8). `—` while unknown. */
export function Tick({ value, className }: Readonly<{ value: number | null; className?: string }>) {
  const { shown, ticking } = useTick(value);
  return <span className={cx("c-tick", ticking && "c-tick-moving", className)}>{shown ?? "—"}</span>;
}

/**
 * Which of `keys` arrived after the view's first render (A9). A key stays
 * marked for one panel move, then is ordinary again; on the first render
 * nothing is new.
 */
export function useArrivals(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const joined = keys.join("\n");
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(keys);
      return;
    }
    const known = seen.current;
    const arrived = keys.filter((key) => !known.has(key));
    for (const key of keys) known.add(key);
    if (arrived.length === 0 || reducedMotion()) return;
    setFresh(new Set(arrived));
    const timer = window.setTimeout(() => setFresh(new Set()), MOTION["--c-d3"]);
    return () => window.clearTimeout(timer);
  // The keys' text is the dependency; the array is new on every render.
  }, [joined]);
  return fresh;
}

/** The class a newly arrived row wears. */
export const ARRIVED = "c-arrived";
