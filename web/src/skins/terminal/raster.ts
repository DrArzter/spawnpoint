// A small rasteriser for the host scene: shapes described as fields over a
// square space, sampled into a grid of brightness per character cell.
//
// A cell of the scene is about twice as tall as it is wide (12px B612 Mono on
// a 14px line), so a scene of cols × rows cells is drawn in a square space of
// cols × rows·CELL_ASPECT units, and every shape below is measured in those.

export type Grid = readonly (readonly number[])[];

/** Negative inside the ink, positive outside. Only the sign is used. */
export type Field = (x: number, y: number) => number;

export const CELL_ASPECT = 14 / 7.2;

const SAMPLES_ACROSS = 3;
const SAMPLES_DOWN = 6;

/** Brightness per cell: the share of the cell's samples that fall in the ink. */
export function rasterise(cols: number, rows: number, field: Field): Grid {
  const grid: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < cols; c += 1) {
      let inside = 0;
      for (let j = 0; j < SAMPLES_DOWN; j += 1) {
        const y = (r + (j + 0.5) / SAMPLES_DOWN) * CELL_ASPECT;
        for (let i = 0; i < SAMPLES_ACROSS; i += 1) {
          if (field(c + (i + 0.5) / SAMPLES_ACROSS, y) <= 0) inside += 1;
        }
      }
      row.push(Math.round((inside / (SAMPLES_ACROSS * SAMPLES_DOWN)) * 100) / 100);
    }
    grid.push(row);
  }
  return grid;
}

export function disc(cx: number, cy: number, radius: number): Field {
  return (x, y) => Math.hypot(x - cx, y - cy) - radius;
}

/** A segment from a to b with round ends of the given radius. */
export function capsule(ax: number, ay: number, bx: number, by: number, radius: number): Field {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  return (x, y) => {
    const apx = x - ax;
    const apy = y - ay;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / length2));
    return Math.hypot(apx - abx * t, apy - aby * t) - radius;
  };
}

/**
 * A toothed rim seen face on: solid from the inner radius out to the root
 * circle, then trapezoid teeth out to the tip circle. `angle` turns it; one
 * tooth's pitch is 2π / teeth.
 */
export function gearRim(cx: number, cy: number, tip: number, root: number, inner: number, teeth: number, angle: number): Field {
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.hypot(dx, dy);
    if (r < inner) return 1;
    if (r <= root) return -1;
    if (r > tip) return 1;
    const turns = ((Math.atan2(dy, dx) + angle) / (2 * Math.PI)) * teeth;
    const along = turns - Math.floor(turns);
    const depth = (r - root) / (tip - root);
    const halfWidth = 0.23 - 0.08 * depth;
    return Math.abs(along - 0.5) <= halfWidth ? -1 : 1;
  };
}

export function union(...fields: readonly Field[]): Field {
  return (x, y) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (const field of fields) nearest = Math.min(nearest, field(x, y));
    return nearest;
  };
}

export function subtract(shape: Field, hole: Field): Field {
  return (x, y) => Math.max(shape(x, y), -hole(x, y));
}
