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

test("the Profile accent well's default equals the iris token", () => {
  const tokens = sheets.find((sheet) => sheet.name === "tokens.css")!.text;
  assert.equal(tokens.match(/--c-accent:\s*(#[0-9A-Fa-f]{6})/)?.[1]?.toLowerCase(), IRIS);
});
