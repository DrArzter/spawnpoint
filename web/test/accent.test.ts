import assert from "node:assert/strict";
import test from "node:test";

import { contrast, deriveAccent, parseHex, readableOn, TEXT_CONTRAST, toHex } from "../src/styles/accent.ts";

const rgb = (hex: string) => {
  const parsed = parseHex(hex);
  assert.ok(parsed, `${hex} should parse`);
  return parsed;
};

const LIGHT_SURFACE = rgb("#ffffff");
const DARK_SURFACE = rgb("#333333");

test("the shipped blue derives back to the palette it was taken from", () => {
  // The fill is kept exactly; the ink lands within a shade of the hand-picked
  // #1967d2, which is the check that the walk agrees with the design system.
  const light = deriveAccent("#1a73e8", "light");
  assert.ok(light);
  assert.equal(light.tokens["--primary"], "#1a73e8");
  assert.ok(contrast(rgb(light.ink), rgb("#1967d2")) < 1.1, `ink ${light.ink} should sit beside #1967d2`);

  const dark = deriveAccent("#1a73e8", "dark");
  assert.ok(dark);
  assert.ok(contrast(rgb(dark.ink), rgb("#8ab4f8")) < 1.2, `ink ${dark.ink} should sit beside #8ab4f8`);
});

test("a pale yellow is darkened until a link made of it can be read", () => {
  const derived = deriveAccent("#ffe94d", "light");
  assert.ok(derived);
  assert.equal(derived.adjusted, true);
  assert.ok(contrast(rgb(derived.ink), LIGHT_SURFACE) >= TEXT_CONTRAST);
});

test("a near-black is lightened for the dark theme rather than left invisible", () => {
  const derived = deriveAccent("#101418", "dark");
  assert.ok(derived);
  assert.equal(derived.adjusted, true);
  assert.ok(contrast(rgb(derived.ink), DARK_SURFACE) >= TEXT_CONTRAST);
});

test("every derived ink clears the text bar, whatever was picked", () => {
  const picks = ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#808080", "#ff6666", "#7b1fa2", "#00e5ff"];
  for (const theme of ["light", "dark"] as const) {
    const surface = theme === "light" ? LIGHT_SURFACE : DARK_SURFACE;
    for (const pick of picks) {
      const derived = deriveAccent(pick, theme);
      assert.ok(derived, `${pick} should derive`);
      const ratio = contrast(rgb(derived.ink), surface);
      assert.ok(ratio >= TEXT_CONTRAST, `${pick} on ${theme}: ink contrast ${ratio.toFixed(2)}`);
    }
  }
});

test("a label on the filled accent is readable too", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const pick of ["#ffe94d", "#1a73e8", "#000000", "#ffffff", "#ff6666"]) {
      const derived = deriveAccent(pick, theme);
      assert.ok(derived);
      const ratio = contrast(rgb(derived.tokens["--on-primary"]), rgb(derived.tokens["--primary"]));
      assert.ok(ratio >= TEXT_CONTRAST, `${pick} on ${theme}: label contrast ${ratio.toFixed(2)}`);
    }
  }
});

test("the ink clears the bar on the canvas and inside a tonal chip, not just on a card", () => {
  // The regression this guards: #1a73e8 is 4.53 on white and 4.27 on the canvas
  // behind it, so checking the card alone shipped a link nobody could read.
  const grounds = { light: ["#ffffff", "#f8f9fa"], dark: ["#333333", "#222222"] } as const;
  for (const theme of ["light", "dark"] as const) {
    for (const pick of ["#1a73e8", "#ffe94d", "#00838f", "#c2185b", "#5f6368"]) {
      const derived = deriveAccent(pick, theme);
      assert.ok(derived);
      for (const ground of grounds[theme]) {
        const ratio = contrast(rgb(derived.ink), rgb(ground));
        assert.ok(ratio >= TEXT_CONTRAST, `${pick} on ${theme} ${ground}: ${ratio.toFixed(2)}`);
      }
      const container = derived.tokens["--primary-container"];
      if (container.startsWith("#")) {
        const ratio = contrast(rgb(derived.tokens["--on-primary-container"]), rgb(container));
        assert.ok(ratio >= TEXT_CONTRAST, `${pick} on ${theme} container: ${ratio.toFixed(2)}`);
      }
    }
  }
});

test("a colour that is already readable keeps its exact hue", () => {
  const kept = readableOn(rgb("#137333"), LIGHT_SURFACE);
  assert.equal(kept.adjusted, false);
  assert.equal(toHex(kept.colour), "#137333");
});

test("nonsense is refused rather than guessed at", () => {
  assert.equal(deriveAccent("not a colour", "light"), null);
  assert.equal(parseHex("#12345"), null);
  assert.deepEqual(parseHex("#abc"), parseHex("#aabbcc"));
});
