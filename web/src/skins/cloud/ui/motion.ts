/*
 * The motion tokens a timer needs, by the name tokens.css gives them. The
 * cloud-css test checks that each number here equals its token, so a dwell
 * or a tick is never tuned in one place and not the other.
 */
export const MOTION = {
  "--c-d1": 140,
  "--c-d2": 240,
  "--c-d3": 420,
  "--c-d4": 900,
  "--c-d-tick": 660,
  "--c-shake": 250,
  "--c-dwell-copy": 1400,
  "--c-dwell-toast": 3600,
  "--c-clock": 1000,
} as const;

/** True when the person asked the system for less motion. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
