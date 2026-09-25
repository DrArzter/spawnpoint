import { useMemo } from "react";

import type { ServerState } from "../../model";
import { HostScene, type Painter } from "./HostScene";
import marks from "./marks.json";
import { CELL_ASPECT, capsule, disc, gearRim, rasterise, subtract, union, type Grid } from "./raster";

// The terminal's own icon for a game: what the host scene draws, and how it
// moves while the host is online. A mark sampled from a game's symbol keeps
// still and breathes; the Factorio gear turns; the Zomboid zombie walks.
// Every painter answers for a phase, the scene's tick count, so a picture at
// phase 0 is the picture at rest.
export type SceneSize = "40x18" | "24x11";
const dimensions: Record<SceneSize, readonly [cols: number, rows: number]> = { "40x18": [40, 18], "24x11": [24, 11] };

type GameRef = Readonly<{ id: string; code?: string }> | undefined;

export function GameIcon({ game, size, state }: Readonly<{ game: GameRef; size: SceneSize; state: ServerState }>) {
  const painter = useMemo(() => painterFor(game, size), [game?.id, game?.code, size]);
  return <HostScene painter={painter} state={state} />;
}

export function painterFor(game: GameRef, size: SceneSize): Painter {
  const key = `${game?.id ?? ""} ${game?.code ?? ""}`.toLowerCase();
  const [cols, rows] = dimensions[size];
  if (key.includes("minecraft")) return still(marks.minecraft[size]);
  if (key.includes("factorio")) return turningGear(cols, rows);
  if (key.includes("zomboid")) return walkingZombie(cols, rows);
  return still(marks.spawnpoint[size]);
}

function still(grid: Grid): Painter {
  return { cols: grid[0]?.length ?? 0, rows: grid.length, paint: () => grid };
}

// A rim of GEAR_TEETH teeth on GEAR_SPOKES spokes, turning one tooth of
// pitch every GEAR_TURN ticks. The spokes are what the eye follows; with
// four of them the picture repeats every two teeth, so the frames of that
// period are drawn once and kept.
const GEAR_TEETH = 8;
const GEAR_SPOKES = 4;
const GEAR_TURN = 16;
const GEAR_PERIOD = GEAR_TURN * (GEAR_TEETH / GEAR_SPOKES);

function turningGear(cols: number, rows: number): Painter {
  const width = cols;
  const height = rows * CELL_ASPECT;
  const cx = width / 2;
  const cy = height / 2;
  const tip = Math.min(width, height) * 0.48;
  const frames = new Map<number, Grid>();
  return {
    cols,
    rows,
    paint: (phase) => {
      const step = ((phase % GEAR_PERIOD) + GEAR_PERIOD) % GEAR_PERIOD;
      const drawn = frames.get(step);
      if (drawn) return drawn;
      const angle = (step / GEAR_TURN) * ((2 * Math.PI) / GEAR_TEETH);
      const rim = gearRim(cx, cy, tip, tip * 0.72, tip * 0.6, GEAR_TEETH, angle);
      const hub = subtract(disc(cx, cy, tip * 0.26), disc(cx, cy, tip * 0.1));
      const spokes = Array.from({ length: GEAR_SPOKES }, (_, i) => {
        const at = (i * 2 * Math.PI) / GEAR_SPOKES - angle;
        return capsule(cx, cy, cx + Math.cos(at) * tip * 0.66, cy + Math.sin(at) * tip * 0.66, tip * 0.07);
      });
      const frame = rasterise(cols, rows, union(rim, hub, ...spokes));
      frames.set(step, frame);
      return frame;
    },
  };
}

// A walk cycle of WALK_STEP ticks; the figure shambles right at WALK_PACE
// cells a tick, leaves by one edge and comes back in by the other. At phase
// 0 it stands in the middle. One leg swings and lifts, the other drags.
const WALK_STEP = 12;
const WALK_PACE = 0.35;

function walkingZombie(cols: number, rows: number): Painter {
  const width = cols;
  const height = rows * CELL_ASPECT;
  const h = height * 0.9;
  const figureWidth = h * 0.55;
  return {
    cols,
    rows,
    paint: (phase) => {
      const w = ((phase % WALK_STEP) / WALK_STEP) * 2 * Math.PI;
      const x0 = ((phase * WALK_PACE + width / 2 + figureWidth / 2) % (width + figureWidth)) - figureWidth;
      const top = (height - h) / 2 + 0.02 * h * (1 - Math.abs(Math.cos(w)));

      const hip = { x: x0 + figureWidth * 0.3, y: top + h * 0.52 };
      const shoulder = { x: x0 + figureWidth * 0.36, y: top + h * 0.22 };
      const head = disc(x0 + figureWidth * 0.42, top + h * 0.1, h * 0.09);
      const torso = capsule(shoulder.x, shoulder.y, hip.x, hip.y, h * 0.07);
      const arms = [
        capsule(shoulder.x, shoulder.y, shoulder.x + h * 0.32, shoulder.y + h * (0.04 + 0.02 * Math.sin(w)), h * 0.045),
        capsule(shoulder.x, shoulder.y + h * 0.03, shoulder.x + h * 0.28, shoulder.y + h * (0.11 - 0.02 * Math.sin(w)), h * 0.045),
      ];
      const legs = [leg(hip, h, 0.4 * Math.sin(w), 0.6 * Math.max(0, Math.cos(w))), leg(hip, h, 0.25 * Math.sin(w + Math.PI), 0)];
      return rasterise(cols, rows, union(head, torso, ...arms, ...legs));
    },
  };
}

// Thigh and shin from the hip, `swing` radians forward of straight down and
// `bend` radians back at the knee, ending in a foot.
function leg(hip: Readonly<{ x: number; y: number }>, h: number, swing: number, bend: number) {
  const thigh = h * 0.25;
  const shin = h * 0.23;
  const knee = { x: hip.x + Math.sin(swing) * thigh, y: hip.y + Math.cos(swing) * thigh };
  const foot = { x: knee.x + Math.sin(swing - bend) * shin, y: knee.y + Math.cos(swing - bend) * shin };
  return union(
    capsule(hip.x, hip.y, knee.x, knee.y, h * 0.055),
    capsule(knee.x, knee.y, foot.x, foot.y, h * 0.05),
    capsule(foot.x, foot.y, foot.x + h * 0.07, foot.y, h * 0.04),
  );
}
