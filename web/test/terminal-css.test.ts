import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cssRuleTests, parseRules, sourceTexts } from "./support/css.ts";
import { skinOff } from "./support/skins.ts";

// AGENTS.md holds terminal.css to the rules in support/css.ts. A later rule
// that cancels an earlier one is how the next screen inherits a value nobody
// meant.

const root = new URL("../src/", import.meta.url).pathname;
const css = readFileSync(join(root, "skins/terminal/terminal.css"), "utf8");

cssRuleTests("terminal.css", {
  rules: parseRules("terminal.css", css).filter((rule) => !rule.context.includes("keyframes")),
  code: [...sourceTexts(root, /\.(tsx?|html)$/), readFileSync(new URL("../index.html", import.meta.url), "utf8")].join("\n"),
  prefix: "t-",
  // Behaviour the skins share (components/ui): the terminal restyles it under the shared class names.
  shared: new Set(["popover", "snackbar", "timestamp", "tip", "tip-anchor"]),
  scope: 'html[data-skin="terminal"]',
  // A token block is a rule that holds custom properties and nothing else.
  mayHoldLiterals: (rule) => [...rule.declarations.keys()].every((property) => property.startsWith("--")),
  skip: skinOff("terminal"),
});
