// Each miss the old gate let through (gate review, 2026-11-21, §4), drawn as
// a small page. `audit.mjs --self-test` fails when the probe stops naming one.
export const FIXTURES = [
  { miss: "M1", file: "m1-wider.html", widths: [360], expect: ["wider"] },
  { miss: "M2", file: "m2-icon-past.html", widths: [360], expect: ["overflowing"] },
  { miss: "M3", file: "m3-sideways.html", widths: [680], expect: ["sideways"] },
  { miss: "M4", file: "m4-pair.html", widths: [1200], expect: ["misaligned"] },
  { miss: "M6", file: "m6-long-name.html", widths: [840], expect: ["overlaps"] },
  { miss: "M7", file: "m7-lines.html", widths: [840], expect: ["textOverText"] },
  { miss: "M8", file: "m8-mark.html", widths: [840], expect: ["textOverText"] },
  { miss: "M8", file: "m8-icon.html", widths: [840], expect: ["overlaps"] },
  { miss: "M9", file: "m9-dialog.html", widths: [360, 1440], state: { name: "create", steps: [{ click: "[data-action='world.create']" }] }, expect: ["overlaps"] },
  { miss: "M9", file: "m9-clean.html", widths: [360, 1440], state: { name: "create", steps: [{ click: "[data-action='world.create']" }] }, expect: [], clean: ["overlaps", "textOverText", "error"] },
  { miss: "H0", file: "h0-past-left.html", widths: [360], expect: ["overflowing"] },
  { miss: "G1", file: "g1-menu.html", widths: [360], menus: true, expect: ["menuCut", "menuClipped", "menuRagged"] },
  { miss: "G2", file: "g2-layout.html", widths: [840], expect: ["wrapped", "offCentre", "offRail"] },
  { miss: "R2-8", file: "rules.html", widths: [1440], expect: ["packed", "stateTwice", "columns", "repeatedLabel", "iconOffLine", "crumbRepeat", "cardHeights", "gridEdge"] },
  { miss: "none", file: "clean.html", widths: [360, 1440], expect: [], clean: ["wider", "overflowing", "sideways", "overlaps", "textOverText", "wrapped", "offCentre", "misaligned", "packed", "columns", "repeatedLabel", "iconOffLine", "crumbRepeat", "gridEdge", "cardHeights", "stateTwice"] },
];
