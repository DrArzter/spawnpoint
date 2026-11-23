import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { IRIS } from "../src/skins/console/ui/accent.ts";
import { MOTION } from "../src/skins/console/ui/motion.ts";
import { classesStyled, deadClasses, overwrittenProperties, rawLiterals, rulesOf, sheetsIn, shorthandClashes, sourceTexts, unscoped } from "./support/css.ts";

// The console skin's sheets keep the rules AGENTS.md sets for a face's CSS and
// the ones its spec adds (skin-spec §1.6, §7, R13): every styled c-* class has
// a consumer; no selector sets one property twice in one cascade context, by
// itself or through a shorthand and its longhand; every rule is scoped to the
// skin; times, easings and colours live only in tokens.css; the timers in
// motion.ts equal their tokens.

const root = new URL("../src/", import.meta.url).pathname;
const styles = join(root, "skins/console/styles");
const sheets = sheetsIn(styles, ["index.css"]);
const all = rulesOf(sheets);
const code = sourceTexts(join(root, "skins/console"), /\.tsx?$/).join("\n");

test("every c-* class the console sheets style is used by the console skin", () => {
  const dead = deadClasses(classesStyled(all, "c-"), code);
  assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
});

test("no selector sets the same property twice in one cascade context", () => {
  const clashes = overwrittenProperties(all);
  assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
});

test("no selector sets a shorthand and its longhand in one cascade context", () => {
  const clashes = shorthandClashes(all);
  assert.deepEqual(clashes, [], `set the property once:\n${clashes.join("\n")}`);
});

test("every console rule is scoped to the skin", () => {
  assert.deepEqual(unscoped(all, 'html[data-skin="console"]'), []);
});

test("times, easings and colours are tokens, defined only in tokens.css", () => {
  assert.deepEqual(rawLiterals(all.filter((rule) => rule.sheet !== "tokens.css")), []);
});

test("the timers in motion.ts equal their tokens", () => {
  const tokens = readFileSync(join(styles, "tokens.css"), "utf8");
  for (const [name, ms] of Object.entries(MOTION)) {
    const match = tokens.match(new RegExp(`${name}:\\s*([\\d.]+)(ms|s);`));
    assert.ok(match, `${name} is a token`);
    assert.equal(Number(match[1]) * (match[2] === "s" ? 1000 : 1), ms, name);
  }
  const timers = sourceTexts(join(root, "skins/console"), /\.tsx?$/).filter((text) => /set(Timeout|Interval)\([^,]+,\s*\d/.test(text));
  assert.equal(timers.length, 0, "a console timer reads its length from motion.ts");
});

test("the Profile accent well's default equals the iris token", () => {
  const tokens = sheets.find((sheet) => sheet.name === "tokens.css")!.text;
  assert.equal(tokens.match(/--c-accent:\s*(#[0-9A-Fa-f]{6})/)?.[1]?.toLowerCase(), IRIS);
});
