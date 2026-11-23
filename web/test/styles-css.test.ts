import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { classesStyled, deadClasses, overwrittenProperties, rulesOf, sheetsIn, shorthandClashes, sourceTexts } from "./support/css.ts";

// The front door's sheets (src/styles) keep the rules the two skins keep:
// every class has a consumer, and no selector sets a property twice in one
// cascade context, by itself or through a shorthand and its longhand.

const root = new URL("../src/", import.meta.url).pathname;
const all = rulesOf(sheetsIn(join(root, "styles")));
const code = [...sourceTexts(root, /\.(tsx?|html)$/), readFileSync(new URL("../index.html", import.meta.url), "utf8")].join("\n");

test("every class the front-door sheets style is used by the source", () => {
  const dead = deadClasses(classesStyled(all), code);
  assert.deepEqual(dead, [], `styled but never rendered: ${dead.join(", ")}`);
});

test("no front-door selector sets the same property twice in one cascade context", () => {
  const clashes = overwrittenProperties(all);
  assert.deepEqual(clashes, [], `consolidate into one base rule:\n${clashes.join("\n")}`);
});

test("no front-door selector sets a shorthand and its longhand in one cascade context", () => {
  const clashes = shorthandClashes(all);
  assert.deepEqual(clashes, [], `set the property once:\n${clashes.join("\n")}`);
});
