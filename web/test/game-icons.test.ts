import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { painterFor, type SceneSize } from "../src/skins/terminal/GameIcon.tsx";

// The terminal's game icons: every painter fills its scene with brightness
// between 0 and 1 and has something to show at rest; the ones that move do
// so only through their phase, and the ones that do not stay put.

const sizes: readonly SceneSize[] = ["40x18", "24x11"];
const games = {
  spawnpoint: undefined,
  minecraft: { id: "minecraft", code: "MC" },
  factorio: { id: "factorio" },
  zomboid: { id: "zomboid" },
} as const;

function ink(grid: readonly (readonly number[])[]): number {
  return grid.reduce((sum, row) => sum + row.reduce((line, value) => line + value, 0), 0);
}

for (const size of sizes) {
  const [cols, rows] = size.split("x").map(Number);
  for (const [name, game] of Object.entries(games)) {
    test(`${name} at ${size} paints a full grid of brightness and is visible at rest`, () => {
      const painter = painterFor(game, size);
      assert.equal(painter.cols, cols);
      assert.equal(painter.rows, rows);
      for (const phase of [0, 5, 31]) {
        const grid = painter.paint(phase);
        assert.equal(grid.length, rows);
        for (const row of grid) {
          assert.equal(row.length, cols);
          for (const value of row) assert.ok(value >= 0 && value <= 1, `${value} is not a brightness`);
        }
      }
      assert.ok(ink(painter.paint(0)) > cols, `${name} has nothing to show at rest`);
    });
  }
}

test("the gear turns and the zombie walks; the sampled marks keep still", () => {
  const gear = painterFor(games.factorio, "40x18");
  const zombie = painterFor(games.zomboid, "40x18");
  const cube = painterFor(games.minecraft, "40x18");
  assert.notDeepEqual(gear.paint(0), gear.paint(3));
  assert.notDeepEqual(zombie.paint(0), zombie.paint(3));
  assert.deepEqual(cube.paint(0), cube.paint(3));
});

test("the gear comes back round after one turn of its spokes", () => {
  const gear = painterFor(games.factorio, "40x18");
  assert.deepEqual(gear.paint(0), gear.paint(32));
  assert.deepEqual(gear.paint(7), gear.paint(7 + 64));
  assert.notDeepEqual(gear.paint(0), gear.paint(16), "a quarter turn of the spokes is not the same picture");
});

test("the zombie stands in the middle of the scene at rest and never leaves for good", () => {
  const zombie = painterFor(games.zomboid, "40x18");
  const rest = zombie.paint(0);
  const middle = rest.reduce((sum, row) => sum + row.slice(12, 28).reduce((line, value) => line + value, 0), 0);
  assert.ok(middle > ink(rest) * 0.8, "the figure at rest is not centred");
  const later = Array.from({ length: 200 }, (_, phase) => ink(zombie.paint(phase)));
  assert.ok(later.some((amount) => amount === 0) === false || later.filter((amount) => amount > 0).length > 150, "the figure is off screen most of the time");
});
