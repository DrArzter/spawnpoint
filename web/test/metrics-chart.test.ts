import "./support/browser.ts";

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HostMetrics } from "../src/api/contract.ts";
import type { MetricsModel } from "../src/core/models.ts";
import { MetricsPanel, tracePaths } from "../src/skins/terminal/Metrics.tsx";
import { noop } from "./support/fixtures.ts";
import { skinTest } from "./support/skins.ts";

// The terminal skin's own tests skip while it is switched off (ADR-0106).
const test = skinTest("terminal");

// The terminal's metric wells keep every point in its place in the window
// and break the line where the host reported nothing.

const at = (i: number) => new Date(Date.UTC(2026, 8, 25, 0, i)).toISOString();

test("a run of readings is one line and one area under it, from the first point to the last", () => {
  const runs = tracePaths([{ at: at(0), value: 1 }, { at: at(1), value: 2 }, { at: at(2), value: 1 }], 2);
  assert.equal(runs.length, 1);
  assert.match(runs[0]?.line ?? "", /^0\.00,\S+ 240\.00,\S+ 480\.00,\S+$/);
  assert.ok(runs[0]?.area.startsWith("0.00,120 ") && runs[0]?.area.endsWith(" 480.00,120"));
});

test("a gap in the readings is a gap in the line, and a series that starts late starts late", () => {
  const points = [{ at: at(0), value: null }, { at: at(1), value: null }, { at: at(2), value: 3 }, { at: at(3), value: 3 }, { at: at(4), value: null }, { at: at(5), value: 1 }, { at: at(6), value: 2 }];
  const runs = tracePaths(points, 3);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.from, 2);
  assert.ok(runs[0]?.line.startsWith("160.00,"), "the first run begins a third of the way in");
  assert.equal(runs[1]?.from, 5);
});

test("the peak touches the top of the plot and a lone point draws nothing", () => {
  const runs = tracePaths([{ at: at(0), value: 0 }, { at: at(1), value: 10 }], 10);
  assert.ok(runs[0]?.line.endsWith("480.00,8.00"), "the peak sits at the top padding");
  assert.ok(runs[0]?.line.startsWith("0.00,108.00"), "zero sits at the bottom padding");
  assert.deepEqual(tracePaths([{ at: at(0), value: 5 }], 5), []);
  assert.deepEqual(tracePaths([{ at: at(0), value: null }, { at: at(1), value: null }], null), []);
});

test("a caption reads the peak in its host's units and names the series from the catalogue", () => {
  const value: HostMetrics = {
    range: "6h", startedAt: at(0), endedAt: at(3), periodSeconds: 300,
    series: [
      { id: "cpu", label: "server CPU", unit: "percent", capacityUnit: "cores", points: [{ at: at(0), value: 40, capacity: 4 }, { at: at(1), value: 45, capacity: 4 }] },
      { id: "memory", label: "Memory", unit: "percent", capacityUnit: "bytes", points: [{ at: at(0), value: 40, capacity: 2 ** 33 }, { at: at(1), value: 50 }] },
      { id: "networkOut", label: "Network out", unit: "bytesPerSecond", points: [{ at: at(0), value: 2048 }, { at: at(1), value: null }] },
    ],
  };
  const model: MetricsModel = { range: "6h", ranges: [{ id: "6h", label: "6 hours" }], setRange: noop, metrics: { status: "ready", value } };
  const markup = renderToStaticMarkup(createElement(MetricsPanel, { model }));
  assert.match(markup, /<strong>CPU<\/strong><span>peak <strong>1\.8 of 4 cores<\/strong>/, "the catalogue's name, not the server's label");
  assert.match(markup, /<strong>Memory<\/strong><span>peak <strong>50 % of host<\/strong>/, "one reading without a size keeps the series in percent");
  assert.match(markup, /peak <strong>2 KiB\/s<\/strong>/);
});
