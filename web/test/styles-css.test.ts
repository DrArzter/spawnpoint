import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cssRuleTests, rulesOf, sheetsIn, sourceTexts } from "./support/css.ts";

// The front door's sheets (src/styles) keep the rules the two skins keep,
// except scope and prefix: they are the base sheets, and their classes are not
// prefixed.

const root = new URL("../src/", import.meta.url).pathname;

cssRuleTests("front-door sheets", {
  rules: rulesOf(sheetsIn(join(root, "styles"))),
  code: [...sourceTexts(root, /\.(tsx?|html)$/), readFileSync(new URL("../index.html", import.meta.url), "utf8")].join("\n"),
});
