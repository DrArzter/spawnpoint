import assert from "node:assert/strict";
import test from "node:test";

import { POPOVER_GAP, POPOVER_MARGIN, placePopover } from "../src/lib/placement.ts";

const screen = { left: 0, top: 60, width: 1000, height: 700 };
const chip = { left: 300, top: 120, width: 80, height: 28 };
const tip = { width: 200, height: 32 };

test("a popover keeps a gap from its anchor on the side asked for", () => {
  const below = placePopover({ anchor: chip, popover: tip, side: "bottom", align: "center", bounds: screen });
  assert.equal(below.side, "bottom");
  assert.equal(below.top, chip.top + chip.height + POPOVER_GAP);
  const right = placePopover({ anchor: chip, popover: tip, side: "right", align: "center", bounds: screen });
  assert.equal(right.side, "right");
  assert.equal(right.left, chip.left + chip.width + POPOVER_GAP);
});

test("a popover flips when its side would cover the top bar or leave the screen", () => {
  // The bar covers the top 60 px; 40 px above the anchor is less than the tip and its gap.
  const flipped = placePopover({ anchor: { ...chip, top: 100 }, popover: tip, side: "top", align: "center", bounds: screen });
  assert.equal(flipped.side, "bottom");
  const roomy = placePopover({ anchor: { ...chip, top: 400 }, popover: tip, side: "top", align: "center", bounds: screen });
  assert.equal(roomy.side, "top");
  assert.equal(roomy.top, 400 - POPOVER_GAP - tip.height);
});

test("start, centre and end line the popover up with the anchor, and the tail always points at its middle", () => {
  const middle = chip.left + chip.width / 2;
  for (const align of ["start", "center", "end"] as const) {
    const placed = placePopover({ anchor: chip, popover: tip, side: "bottom", align, bounds: screen });
    assert.equal(placed.left + placed.tail, middle, `${align}: the tail points at the anchor's middle`);
  }
  assert.equal(placePopover({ anchor: chip, popover: tip, side: "bottom", align: "start", bounds: screen }).left, chip.left);
  assert.equal(placePopover({ anchor: chip, popover: tip, side: "bottom", align: "end", bounds: screen }).left, chip.left + chip.width - tip.width);
});

test("a popover stays on the screen, and its tail stays off its corners", () => {
  const edge = { left: 2, top: 300, width: 24, height: 24 };
  const placed = placePopover({ anchor: edge, popover: tip, side: "bottom", align: "center", bounds: screen });
  assert.equal(placed.left, POPOVER_MARGIN, "pushed back onto the screen");
  assert.ok(placed.tail >= 14, "the tail does not sit on the rounded corner");
  const far = placePopover({ anchor: { left: 990, top: 300, width: 10, height: 10 }, popover: tip, side: "bottom", align: "center", bounds: screen });
  assert.equal(far.left + tip.width, screen.width - POPOVER_MARGIN);
  assert.ok(far.tail <= tip.width - 14);
});

test("with no room on either side, the popover takes the roomier one", () => {
  const cramped = placePopover({ anchor: { left: 300, top: 90, width: 40, height: 600 }, popover: tip, side: "top", align: "center", bounds: screen });
  assert.equal(cramped.side, "bottom");
});
