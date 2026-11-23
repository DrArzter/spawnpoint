import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { classesStyled, deadClasses, overwrittenProperties, parseRules, rawLiterals, shorthandClashes, sourceTexts, unscoped } from "./support/css.ts";

// AGENTS.md holds terminal.css to rules a screenshot cannot check: every t-*
// class it styles has a consumer, a selector never overwrites its own property
// in the same cascade context (by itself or through a shorthand and its
// longhand), every rule applies only while the terminal skin is on the
// document, and times, easings and colours are tokens. A later rule that
// cancels an earlier one is how the next screen inherits a value nobody meant.

const root = new URL("../src/", import.meta.url).pathname;
const css = readFileSync(join(root, "skins/terminal/terminal.css"), "utf8");
const all = parseRules("terminal.css", css).filter((rule) => !rule.context.includes("keyframes"));
const code = [...sourceTexts(root, /\.(tsx?|html)$/), readFileSync(new URL("../index.html", import.meta.url), "utf8")].join("\n");

test("every t-* class terminal.css styles is used by the skin", () => {
  const dead = deadClasses(classesStyled(all), code);
  assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
});

// Behaviour the skins share (components/ui): the terminal restyles it under the
// shared class names, which their own sheets in src/styles define.
const SHARED = new Set(["snackbar", "timestamp", "tip", "tip-anchor"]);

test("every class terminal.css styles carries the t- prefix", () => {
  const bare = [...classesStyled(all)].filter((name) => !name.startsWith("t-") && !SHARED.has(name));
  assert.deepEqual(bare, [], `the dead-class check sees only t-* names: ${bare.join(", ")}`);
});

test("no selector overwrites its own property later in the same context", () => {
  const clashes = overwrittenProperties(all);
  assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
});

test("no selector sets a shorthand and its longhand in one cascade context", () => {
  const clashes = shorthandClashes(all);
  assert.deepEqual(clashes, [], `set the property once:\n${clashes.join("\n")}`);
});

test("every terminal rule is scoped to the skin", () => {
  assert.deepEqual(unscoped(all, 'html[data-skin="terminal"]'), []);
});

test("times, easings and colours are tokens, defined only in the token blocks", () => {
  // A token block is a rule that holds custom properties and nothing else.
  const outside = all.filter((rule) => ![...rule.declarations.keys()].every((property) => property.startsWith("--")));
  assert.deepEqual(rawLiterals(outside), []);
});
