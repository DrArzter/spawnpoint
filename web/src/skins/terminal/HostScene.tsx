import { useEffect, useState } from "react";

import { cx } from "../../lib/cx";
import type { ServerState } from "../../model";
import type { Grid } from "./raster";

// The adapter between a picture and the screen. A painter hands the scene a
// grid of brightness per cell for a phase of its motion; the scene turns each
// cell into a glyph from a ramp whose densest glyph is the brightest, and
// sets the exposure from the session state. It also keeps time: an online
// host breathes and advances the painter's phase, a transition sweeps one
// brighter scanline down the picture the way a screen redraws, a stopped
// host is dim and still. What the picture is, and how it moves, is the
// painter's business (GameIcon).
const RAMP = " .:-=+*#%@";
const TICK_MS = 150;

export type Painter = Readonly<{ cols: number; rows: number; paint: (phase: number) => Grid }>;

const exposure: Record<ServerState, number> = { running: 1, starting: 0.7, stopping: 0.7, stopped: 0.34, unknown: 0.5 };

function glyph(value: number): string {
  const index = Math.max(0, Math.min(RAMP.length - 1, Math.floor(value * (RAMP.length - 0.01))));
  return RAMP[index] ?? " ";
}

export function HostScene({ painter, state, className }: Readonly<{ painter: Painter; state: ServerState; className?: string }>) {
  const [tick, setTick] = useState(0);
  const moving = state === "running" || state === "starting" || state === "stopping";

  useEffect(() => {
    if (!moving) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => window.clearInterval(timer);
  }, [moving]);

  // Only an online host moves the picture itself; a transition shows it at
  // rest under the sweep, so the sweep is the one thing that changes.
  const grid = painter.paint(state === "running" ? tick : 0);
  const rows = grid.length;
  const breath = state === "running" ? 0.08 * Math.sin(tick / 6) : 0;
  const sweep = state === "starting" || state === "stopping" ? tick % (rows + 4) : -1;
  const lines = grid.map((row, r) => row.map((value) => glyph(value * (exposure[state] + breath) + (r === sweep ? 0.35 : 0))).join(""));

  return (
    <pre aria-hidden="true" className={cx("scene", `scene-${state}`, className)} data-size={`${painter.cols}x${painter.rows}`}>
      {lines.join("\n")}
    </pre>
  );
}
