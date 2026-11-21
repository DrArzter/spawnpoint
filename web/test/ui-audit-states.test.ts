import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { STATES, SURFACES } from "../tools/ui-audit/states.mjs";

/*
 * The UI gate opens every surface the skins can show (web/tools/ui-audit).
 * A skin file that draws a Dialog, SidePanel, Modal or Drawer must name the
 * states that open it, so a new surface cannot ship without the gate seeing it.
 */

const SURFACE = /<(Dialog|SidePanel|Modal|Drawer)\b/;

for (const skin of ["cloud", "terminal"] as const) {
  test(`ui-audit states: every ${skin} surface is opened by a state`, () => {
    const folder = new URL(`../src/skins/${skin}/`, import.meta.url);
    const drawing = readdirSync(folder).filter((file) => file.endsWith(".tsx") && SURFACE.test(readFileSync(new URL(file, folder), "utf8")));
    const listed: Record<string, readonly string[]> = SURFACES[skin];
    assert.deepEqual(drawing.filter((file) => !listed[file]), [], `add these ${skin} files to SURFACES in states.mjs`);
    for (const [file, names] of Object.entries(listed)) {
      assert.ok(drawing.includes(file), `${skin}/${file} draws no surface any more; remove it from SURFACES`);
      for (const name of names) {
        const state = STATES.find((candidate) => candidate.name === name);
        assert.ok(state, `state ${name} is not in STATES`);
        assert.ok(!state.skins || state.skins.includes(skin), `state ${name} does not run on ${skin}`);
      }
    }
  });
}

test("ui-audit states: names are unique and every step is one the walker knows", () => {
  assert.equal(new Set(STATES.map((state) => state.name)).size, STATES.length);
  for (const state of STATES) {
    assert.ok(state.steps.length > 0, state.name);
    for (const step of state.steps) assert.equal(Object.keys(step).filter((key) => ["action", "click", "focus", "key"].includes(key)).length, 1, `${state.name}: ${JSON.stringify(step)}`);
  }
});
