import { useEffect, useState } from "react";

import { cx } from "../../lib/cx";
import type { ServerState } from "../../model";
import marks from "./marks.json";

// The host drawn in glyphs. Each cell of a mark carries a brightness sampled
// from the game's own symbol; the glyph chosen for it comes from a ramp where
// the densest glyph is the brightest. The session state sets the exposure:
// an online host is dense and breathes, a stopped one is sparse and still.
const RAMP = " .:-=+*#%@";
export type SceneMark = keyof typeof marks;
type SceneSize = "40x18" | "24x11";

const exposure: Record<ServerState, number> = { running: 1, starting: 0.7, stopping: 0.7, stopped: 0.34, unknown: 0.5 };

export function sceneMarkFor(game: { id: string; code?: string } | undefined): SceneMark {
  const key = `${game?.id ?? ""} ${game?.code ?? ""}`.toLowerCase();
  if (key.includes("minecraft")) return "minecraft";
  if (key.includes("factorio")) return "factorio";
  if (key.includes("zomboid")) return "zomboid";
  return "spawnpoint";
}

function glyph(value: number): string {
  const index = Math.max(0, Math.min(RAMP.length - 1, Math.floor(value * (RAMP.length - 0.01))));
  return RAMP[index] ?? " ";
}

export function HostScene({ mark, state, size = "40x18", className }: Readonly<{
  mark: SceneMark;
  state: ServerState;
  size?: SceneSize;
  className?: string;
}>) {
  const [tick, setTick] = useState(0);
  const moving = state === "running" || state === "starting" || state === "stopping";

  useEffect(() => {
    if (!moving) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 150);
    return () => window.clearInterval(timer);
  }, [moving]);

  const grid = marks[mark][size];
  const rows = grid.length;
  // Online breathes: a slow sine on the whole frame. A transition sweeps one
  // brighter scanline down the mark, the way a screen redraws.
  const breath = state === "running" ? 0.08 * Math.sin(tick / 6) : 0;
  const sweep = state === "starting" || state === "stopping" ? tick % (rows + 4) : -1;
  const lines = grid.map((row, r) => row.map((value) => glyph(value * (exposure[state] + breath) + (r === sweep ? 0.35 : 0))).join(""));

  return (
    <pre aria-hidden="true" className={cx("scene", `scene-${state}`, className)} data-size={size}>
      {lines.join("\n")}
    </pre>
  );
}
