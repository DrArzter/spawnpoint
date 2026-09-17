import assert from "node:assert/strict";
import test from "node:test";

import { defaultAppearance, validateAppearance } from "../src/access/appearance.ts";

test("nothing chosen means the system theme and the shipped blue", () => {
  assert.deepEqual(defaultAppearance(), { theme: "system", accent: "#1a73e8" });
});

test("a full preference is accepted and the colour is normalised", () => {
  assert.deepEqual(validateAppearance({ theme: "dark", accent: "#FF6666" }), { theme: "dark", accent: "#ff6666" });
});

test("a theme the console cannot render is refused", () => {
  assert.equal(validateAppearance({ theme: "sepia", accent: "#1a73e8" }), null);
});

test("anything that is not a six-digit hex colour is refused", () => {
  for (const accent of ["blue", "#abc", "#12345g", "", "rgb(0,0,0)"]) {
    assert.equal(validateAppearance({ theme: "light", accent }), null, accent);
  }
});

test("a half preference is refused rather than merged", () => {
  assert.equal(validateAppearance({ theme: "dark" }), null);
  assert.equal(validateAppearance({ accent: "#1a73e8" }), null);
});

test("an unknown key is refused, so a typo cannot be stored and forgotten", () => {
  assert.equal(validateAppearance({ theme: "dark", accent: "#1a73e8", density: "compact" }), null);
});
