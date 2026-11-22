import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { STATES, SURFACES } from "../tools/ui-audit/states.mjs";

/*
 * The UI gate opens every surface the skins can show (web/tools/ui-audit).
 * Each Dialog, SidePanel, Modal or Drawer a skin draws belongs to the
 * function that draws it, and that function must name a state for each
 * surface, so a new surface cannot ship without the gate seeing it.
 */

const SURFACE = /<(Dialog|SidePanel|Modal|Drawer)\b/g;
const FUNCTION = /^(?:export )?(?:default )?function (\w+)/;

/** The surfaces in a source file, counted by the top-level function that draws them. */
function surfacesOf(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  let owner = "(module)";
  for (const line of source.split("\n")) {
    owner = FUNCTION.exec(line)?.[1] ?? owner;
    const found = line.match(SURFACE)?.length ?? 0;
    if (found > 0) counts.set(owner, (counts.get(owner) ?? 0) + found);
  }
  return counts;
}

for (const skin of Object.keys(SURFACES) as (keyof typeof SURFACES)[]) {
  test(`ui-audit states: every ${skin} surface is opened by a state`, () => {
    const folder = new URL(`../src/skins/${skin}/`, import.meta.url);
    const listed: Record<string, Record<string, readonly string[]>> = SURFACES[skin];
    const drawn = new Map(readdirSync(folder).filter((file) => file.endsWith(".tsx")).map((file) => [file, surfacesOf(readFileSync(new URL(file, folder), "utf8"))] as const));
    for (const [file, owners] of drawn) {
      for (const [owner, count] of owners) {
        const names = listed[file]?.[owner];
        assert.ok(names, `${skin}/${file}: ${owner} draws ${count} surface(s); name its states in SURFACES in states.mjs`);
        assert.ok(names.length >= count, `${skin}/${file}: ${owner} draws ${count} surfaces but names ${names.length} states`);
      }
    }
    for (const [file, owners] of Object.entries(listed)) {
      for (const [owner, names] of Object.entries(owners)) {
        assert.ok(drawn.get(file)?.has(owner), `${skin}/${file}: ${owner} draws no surface any more; remove it from SURFACES`);
        for (const name of names) {
          const state = STATES.find((candidate) => candidate.name === name);
          assert.ok(state, `state ${name} is not in STATES`);
          assert.ok(!state.skins || state.skins.includes(skin), `state ${name} does not run on ${skin}`);
        }
      }
    }
  });
}

test("ui-audit states: a second surface in a listed function needs a second state", () => {
  const counts = surfacesOf("export function Sheets() {\n  return <><Dialog title=\"a\" /><SidePanel title=\"b\" /></>;\n}\n");
  assert.equal(counts.get("Sheets"), 2);
});

test("ui-audit states: names are unique and every step is one the walker knows", () => {
  assert.equal(new Set(STATES.map((state) => state.name)).size, STATES.length);
  for (const state of STATES) {
    assert.ok(state.steps.length > 0, state.name);
    for (const kind of state.onTop ?? []) assert.ok(["tip", "toast"].includes(kind), `${state.name}: onTop ${kind}`);
    for (const step of state.steps) assert.equal(Object.keys(step).filter((key) => ["action", "click", "focus", "key"].includes(key)).length, 1, `${state.name}: ${JSON.stringify(step)}`);
  }
});
