import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import type { HostMetricSeries } from "../src/api/contract.ts";
import { setLocale } from "../src/i18n/index.ts";
import { ru } from "../src/i18n/ru.ts";
import { binaryCeiling, byteReading, isAbsolute, metricScale, seriesLabel } from "../src/lib/metrics.ts";
import { chartMax } from "../src/skins/console/ui/TimeSeriesChart.tsx";

// How a metric series reads (H1, H3, H4, G18): an absolute only when every
// reading knows its host's size, a rate for the network, round binary axis
// steps, and the series' name from the catalogue.

const at = (minute: number) => `2026-11-21T10:${String(minute).padStart(2, "0")}:00.000Z`;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const cpu = (points: HostMetricSeries["points"]): HostMetricSeries => ({ id: "cpu", label: "CPU", unit: "percent", capacityUnit: "cores", points });
const memory = (points: HostMetricSeries["points"]): HostMetricSeries => ({ id: "memory", label: "Memory", unit: "percent", capacityUnit: "bytes", points });

test("a series reads as an absolute only when every known reading carries its host's capacity", () => {
  const whole = cpu([{ at: at(0), value: null }, { at: at(1), value: 50, capacity: 2 }, { at: at(2), value: 65, capacity: 2 }]);
  assert.equal(isAbsolute(whole), true, "an empty slot needs no capacity");
  const scale = metricScale(whole);
  assert.deepEqual(scale.points.map((point) => point.value), [null, 1, 1.3]);
  assert.deepEqual(scale.reading(1.3, 2), { value: "1.3", unit: "of 2 cores" });
  assert.equal(scale.text(1.3), "1.3 cores");
  assert.equal(scale.share(2), "65 % of host", "the percentage moves to the tooltip");

  const partial = cpu([{ at: at(0), value: 50, capacity: 2 }, { at: at(1), value: 65 }]);
  assert.equal(isAbsolute(partial), false);
  const percent = metricScale(partial);
  assert.deepEqual(percent.points.map((point) => point.value), [50, 65], "the whole series stays in percent");
  assert.deepEqual(percent.reading(65), { value: "65", unit: "% of host" });
  assert.equal(percent.text(65.4), "65 %");
  assert.equal(percent.share(1), null);
  assert.equal(percent.ceiling, 100);
  assert.equal(isAbsolute({ ...partial, capacityUnit: undefined, points: [{ at: at(0), value: 10, capacity: 2 }] }), false, "no capacity unit, no absolute");
});

test("memory reads in GiB of its host, with one decimal, and a joined reading keeps its host's size", () => {
  const scale = metricScale(memory([
    { at: at(0), value: 25, capacity: 8 * GIB },
    { at: at(1), value: 50, capacity: 8 * GIB, interpolated: true },
    { at: at(2), value: 30.625, capacity: 16 * GIB },
  ]));
  assert.equal(scale.absolute, true);
  assert.deepEqual(scale.points.map((point) => point.value), [2 * GIB, 4 * GIB, 4.9 * GIB]);
  assert.equal(scale.points[1]?.interpolated, true);
  assert.deepEqual(scale.reading(4.9 * GIB, 16 * GIB), { value: "4.9", unit: "GiB of 16 GiB" });
  assert.equal(scale.text(2 * GIB), "2.0 GiB", "a fixed decimal keeps the width");
  assert.equal(scale.ceiling, 16 * GIB, "the chart tops out at the largest host in the window");
  assert.deepEqual([scale.ceiling, scale.ceiling / 2].map(scale.tick), ["16 GiB", "8 GiB"]);
});

test("the network is a rate in binary units, and its axis steps are round", () => {
  const scale = metricScale({ id: "networkIn", label: "Network in", unit: "bytesPerSecond", points: [{ at: at(0), value: 1.25 * MIB }, { at: at(1), value: null }] });
  assert.deepEqual(scale.reading(1.25 * MIB), { value: "1.3", unit: "MiB/s" });
  assert.equal(scale.text(512), "512 B/s");
  assert.equal(scale.text(3 * 1024), "3 KiB/s");
  assert.equal(scale.ceiling, 2 * MIB);
  assert.deepEqual([scale.ceiling, scale.ceiling / 2, 0].map(scale.tick), ["2 MiB/s", "1 MiB/s", "0 B/s"]);
  assert.deepEqual(byteReading(1.5 * GIB), { value: "1.50", unit: "GiB" });
});

test("a byte axis tops out at a binary step, so its labels and their halves are round", () => {
  assert.equal(binaryCeiling(100_000_000), 96 * MIB, "not 95.37 MiB");
  assert.equal(binaryCeiling(3.2 * MIB), 4 * MIB);
  assert.equal(binaryCeiling(700 * 1024), 768 * 1024);
  assert.equal(binaryCeiling(1000), 1024);
  assert.equal(binaryCeiling(0), 1);
  for (const peak of [5, 900, 70_000, 12 * MIB, 3 * GIB]) {
    const top = binaryCeiling(peak);
    assert.ok(top >= peak && top / 2 < peak * 2, `${peak} → ${top}`);
    for (const tick of [top, top / 2]) assert.match(byteReading(tick, { trim: true, decimals: 2 }).value, /^\d+$/, `${tick} reads whole`);
  }
  assert.equal(chartMax([{ at: at(0), value: 100_000_000 }], "binary"), 96 * MIB);
  assert.equal(chartMax([{ at: at(0), value: 1.3 }], 4), 4, "a capacity is the ceiling as given");
});

test("a series is named from the catalogue by its id, and an unknown one keeps the server's label", () => {
  assert.equal(seriesLabel({ id: "networkOut", label: "Network out" }), "Network out");
  assert.equal(seriesLabel({ id: "disk", label: "Disk" }), "Disk");
  try {
    setLocale("ru", ru);
    assert.equal(seriesLabel({ id: "memory", label: "Memory" }), "Память");
    assert.equal(seriesLabel({ id: "cpu", label: "CPU" }), "ЦП");
    assert.deepEqual(metricScale(cpu([{ at: at(0), value: 65, capacity: 2 }])).reading(1.3, 2), { value: "1,3", unit: "из 2 ядер" });
  } finally {
    setLocale("en");
  }
});
