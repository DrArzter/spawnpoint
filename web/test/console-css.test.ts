import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { IRIS } from "../src/skins/console/ui/accent.ts";
import { MOTION } from "../src/skins/console/ui/motion.ts";
import { cssRuleTests, rulesOf, sheetsIn, sourceTexts } from "./support/css.ts";

// The console skin's sheets keep the rules in support/css.ts and the ones its
// spec adds (skin-spec section 1.6, 7, R13): times, easings and colours live
// only in tokens.css, and the timers in motion.ts equal their tokens.

const root = new URL("../src/", import.meta.url).pathname;
const styles = join(root, "skins/console/styles");
const sheets = sheetsIn(styles, ["index.css"]);

cssRuleTests("console sheets", {
  rules: rulesOf(sheets),
  code: sourceTexts(join(root, "skins/console"), /\.tsx?$/).join("\n"),
  prefix: "c-",
  scope: 'html[data-skin="console"]',
  mayHoldLiterals: (rule) => rule.sheet === "tokens.css",
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

test("the bars that hold still through a view change are their own layers, above the page, with no animation (A1n)", () => {
  const rules = rulesOf(sheets);
  const ruleFor = (selector: string) => rules.filter((rule) => rule.selectors.some((s) => s.endsWith(selector)));
  for (const bar of ["c-topbar", "c-bottom"]) {
    assert.ok(ruleFor(`.${bar}`).some((rule) => rule.declarations.get("view-transition-name") === bar), `.${bar} names its layer`);
    assert.ok(ruleFor(`::view-transition-group(${bar})`).some((rule) => rule.declarations.get("z-index") === "1"), `${bar} is above the page`);
    assert.ok(ruleFor(`::view-transition-new(${bar})`).some((rule) => rule.declarations.get("animation") === "none"), `${bar} does not animate`);
    assert.ok(ruleFor(`::view-transition-old(${bar})`).some((rule) => rule.declarations.get("display") === "none"), `${bar} shows no old snapshot`);
  }
  // A tab switch keeps the header still (A3): it is named only for page and pane switches.
  const head = rules.filter((rule) => rule.declarations.get("view-transition-name") === "c-head").flatMap((rule) => rule.selectors);
  assert.ok(head.length > 0);
  for (const selector of head) assert.match(selector, /\[data-transition="(page|pane)"\]/, selector);
});

test("a hover state applies only where a pointer can hover, so a tap leaves no grey behind", () => {
  const loose = rulesOf(sheets)
    .filter((rule) => rule.selectors.some((selector) => selector.includes(":hover")) && !rule.context.includes("(hover: hover)"))
    .map((rule) => `${rule.sheet}:${rule.line} ${rule.selectors.join(", ")}`);
  assert.deepEqual(loose, []);
  // Keyboard focus keeps its look on every device: no :focus-visible rule sits behind the hover query.
  const hidden = rulesOf(sheets).filter((rule) => rule.context.includes("(hover: hover)") && rule.selectors.some((selector) => selector.includes(":focus-visible")));
  assert.deepEqual(hidden.map((rule) => `${rule.sheet}:${rule.line}`), []);
});

test("the Profile accent well's default equals the iris token", () => {
  const tokens = sheets.find((sheet) => sheet.name === "tokens.css")!.text;
  assert.equal(tokens.match(/--c-accent:\s*(#[0-9A-Fa-f]{6})/)?.[1]?.toLowerCase(), IRIS);
});
