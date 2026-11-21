import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import type { ConsoleModel, MetricsModel } from "../src/core/models.ts";
import type { HostMetrics } from "../src/api/contract.ts";
import { ConsoleTab } from "../src/skins/cloud/tabs/Console.tsx";
import { hostRunning, metricFormat, MetricsTab, stripRuns } from "../src/skins/cloud/tabs/Metrics.tsx";
import { Terminal } from "../src/skins/cloud/ui/Terminal.tsx";
import { chartGeometry, chartMax, chartSummary, nextCursor, PLOT, TimeSeriesChart, type ChartPoint } from "../src/skins/cloud/ui/TimeSeriesChart.tsx";

/*
 * The cloud chart, metrics and console (skin-spec §6.3.6, §6.3.7, §10): a
 * missing reading splits the line and is hatched, the chart names itself and
 * its latest and peak values, the data table lists every reading, the host
 * strip comes from the series, and the log reads newest last.
 */

const noop = () => undefined;
const at = (minute: number) => `2026-11-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
const series = (values: readonly (number | null)[]): ChartPoint[] => values.map((value, index) => ({ at: at(index), value }));
const format = (value: number) => `${value} %`;
const time = (stamp: string) => stamp.slice(11, 16);

test("a missing reading ends a run: two lines, one hatched gap, a lone reading is a dot", () => {
  const shape = chartGeometry(series([10, 20, null, null, 40, 50, null, 30]), 100);
  assert.equal(shape.lines.length, 2);
  assert.equal(shape.areas.length, 2);
  assert.equal(shape.dots.length, 1, "the last reading stands alone");
  assert.equal(shape.gaps.length, 2);
  assert.ok(shape.lines.every((line) => line.split("M").length === 2), "no line jumps across a gap");
  const first = shape.gaps[0]!;
  assert.ok(first.x > 0 && first.x + first.width <= PLOT.width);
});

test("the y axis tops out at 100 for a percentage, else at the peak rounded up", () => {
  assert.equal(chartMax(series([12, 40]), true), 100);
  assert.equal(chartMax(series([3_400_000, null]), false), 5_000_000);
  assert.equal(chartMax(series([null]), false), 1);
  const summary = chartSummary(series([10, null, 30, 20]));
  assert.deepEqual([summary?.latest, summary?.peak.value, summary?.average, summary?.count], [20, 30, 20, 3]);
  assert.equal(chartSummary(series([null, null])), null);
});

test("a lone reading is an HTML mark, so the stretched plot cannot squash it", () => {
  const markup = renderToStaticMarkup(createElement(TimeSeriesChart, { label: "CPU", range: "6 hours", points: series([null, 30, null]), format, time, percent: true }));
  assert.doesNotMatch(markup, /<circle/);
  assert.match(markup, /class="c-chart-point" style="left:50%;top:/);
});

test("the chart is one focusable group named by its series, range, latest and peak, with a data table on demand", () => {
  const markup = renderToStaticMarkup(createElement(TimeSeriesChart, { label: "CPU", range: "24 hours", points: series([10, null, 30, 20]), format, time, percent: true }));
  assert.match(markup, /role="group"[^>]*tabindex="0"|tabindex="0"[^>]*role="group"/);
  assert.match(markup, /aria-label="CPU, 24 hours, latest 20 %, peak 30 %"/);
  assert.match(markup, /aria-roledescription="chart"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /data-action="chart\.data"[^>]*>.*Show data/);
  assert.doesNotMatch(markup, /<table/, "the readings table waits for Show data");
});

test("the keyboard cursor moves point by point, stops at the ends and starts from the latest reading", () => {
  assert.equal(nextCursor("ArrowLeft", null, 3), 1, "the first press starts from the latest reading");
  assert.equal(nextCursor("ArrowRight", 2, 3), 2, "it stops at the last reading");
  assert.equal(nextCursor("ArrowLeft", 0, 3), 0, "and at the first");
  assert.equal(nextCursor("Home", 2, 3), 0);
  assert.equal(nextCursor("End", 0, 3), 2);
  assert.equal(nextCursor("Enter", 1, 3), null);
  assert.equal(nextCursor("End", null, 0), null);
});

test("the host strip is running wherever any series reported, joined into runs", () => {
  const metrics: HostMetrics = {
    range: "6h", startedAt: at(0), endedAt: at(5), periodSeconds: 300,
    series: [
      { id: "cpu", label: "CPU", unit: "percent", points: series([null, null, 5, 6, null, null]) },
      { id: "net", label: "Network in", unit: "bytes", points: series([null, 1, null, 2, null, null]) },
    ],
  };
  const mask = hostRunning(metrics);
  assert.deepEqual(mask, [false, true, true, true, false, false]);
  assert.deepEqual(stripRuns(mask), [{ on: false, from: 0, length: 1 }, { on: true, from: 1, length: 3 }, { on: false, from: 4, length: 2 }]);
  assert.equal(metricFormat("percent")(42.04), "42 %");
  assert.equal(metricFormat("bytes")(2048), "2 KiB");
});

test("the metrics tab draws the strip, a stat card and a chart per series, and the empty series' one line", () => {
  const value: HostMetrics = {
    range: "6h", startedAt: at(0), endedAt: at(3), periodSeconds: 300,
    series: [
      { id: "cpu", label: "CPU", unit: "percent", points: series([null, 20, 40, 30]) },
      { id: "net", label: "Network in", unit: "bytes", points: series([null, null, null, null]) },
    ],
  };
  const model: MetricsModel = { range: "6h", ranges: [{ id: "6h", label: "6 hours" }, { id: "24h", label: "24 hours" }], setRange: noop, metrics: { status: "ready", value } };
  const markup = renderToStaticMarkup(createElement(MetricsTab, { model, worldId: "rostik" }));
  assert.match(markup, /Host running 75 % of the last 6 hours/);
  assert.match(markup, /<span>Peak 40 % at \d\d:02<\/span><span>Avg 30 %<\/span>/);
  assert.match(markup, /The host reported nothing in this window\./);
  assert.doesNotMatch(markup, /Bytes/, "a series with no readings has no legend");
  assert.match(markup, /aria-label="CPU, 6 hours, latest 30 %, peak 40 %"/);
  assert.match(markup, /5-minute readings/);
  assert.match(markup, /role="radiogroup"[^>]*aria-label="Range"|aria-label="Range"[^>]*role="radiogroup"/);
});

test("the console reads newest last in a log region, and an offline world draws its verbs disabled with the reason", () => {
  const lines = [
    { id: "a", at: at(1), who: "Alex", command: "list", status: { kind: "ok" as const, label: "Answered" }, output: "3 online", pending: false },
    { id: "b", at: at(2), who: "Mira", command: "say hi", status: { kind: "progress" as const, label: "Waiting for the game" }, output: null, pending: true },
  ];
  const log = renderToStaticMarkup(createElement(Terminal, { label: "Rostik console", lines }));
  assert.match(log, /aria-label="Rostik console"[^>]*role="log"/);
  assert.match(log, /<table aria-label="Commands"/, "the table is not named twice");
  assert.match(log, /aria-live="polite"/);
  assert.ok(log.indexOf("list") < log.indexOf("say hi"), "newest last");
  const run = action("console.run", "Run", noop, { disabled: true, hint: "The world is not online" });
  const offline: ConsoleModel = { game: undefined, world: null, session: { kind: "off", label: "Stopped" }, online: false, log: null, draft: "", setDraft: noop, run, quickCommands: [action("console.quick", "list", noop, { disabled: true, hint: "The world is not online" })], unavailable: "The world is not online" };
  const markup = renderToStaticMarkup(createElement(ConsoleTab, { model: offline, world: "Rostik" }));
  assert.match(markup, /World is offline/);
  assert.match(markup, /aria-disabled="true"[^>]*data-action="console\.run"/);
  assert.match(markup, /aria-disabled="true"[^>]*data-action="console\.quick"/);
  assert.match(markup, /readOnly=""|readonly=""/);
  assert.match(markup, /data-tip="The world is not online"/);
});
