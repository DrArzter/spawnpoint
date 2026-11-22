import "./support/browser.ts";

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ShellModel } from "../src/core/models.ts";
import { clock, eta } from "../src/lib/operation-time.ts";
import { flashItems } from "../src/skins/console/Shell.tsx";
import { RunningTime } from "../src/skins/console/ui/Flashbar.tsx";

// An operation's time: elapsed beside the ETA, or "taking longer" once the
// usual duration has passed, from one formatter in every place it shows.

const START = Date.parse("2026-11-21T12:00:00.000Z");
const since = new Date(START).toISOString();
const queue = { items: [], dismiss: () => undefined };
const at = (seconds: number) => START + seconds * 1000;

test("a duration is minutes and seconds, minutes carrying past an hour", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(100), "1:40");
  assert.equal(clock(3725.9), "62:05");
  assert.equal(clock(-5), "0:00");
});

test("the ETA counts down to the usual duration", () => {
  assert.deepEqual(eta(since, { expectedSeconds: 210, expectedSamples: 10 }, at(110)), { kind: "left", text: "ETA ~1:40", tip: "Usually 3:30, from the last 10 runs" });
  assert.equal(eta(since, { expectedSeconds: 210 }, at(0))?.tip, "Usually 3:30");
});

test("past the usual duration the operation is taking longer, with the usual time as the tip", () => {
  assert.deepEqual(eta(since, { expectedSeconds: 60, expectedSamples: 4 }, at(60)), { kind: "over", text: "Taking longer", tip: "Usually 1:00, from the last 4 runs" });
  assert.equal(eta(since, { expectedSeconds: 60 }, at(500))?.kind, "over");
});

test("no history, or no start time, gives no ETA", () => {
  assert.equal(eta(since, {}, at(30)), null);
  assert.equal(eta(undefined, { expectedSeconds: 60 }, at(30)), null);
  assert.equal(eta("not a time", { expectedSeconds: 60 }, at(30)), null);
});

function render(expectation: Parameters<typeof RunningTime>[0]["expectation"], seconds: number): string {
  mock.timers.enable({ apis: ["Date"], now: at(seconds) });
  try {
    return renderToStaticMarkup(createElement(RunningTime, { since, expectation }));
  } finally {
    mock.timers.reset();
  }
}

test("running time shows the elapsed time and the countdown", () => {
  const html = render({ expectedSeconds: 210, expectedSamples: 10 }, 130);
  assert.match(html, /class="c-mono">2:10</);
  assert.match(html, /class="c-mono c-eta" data-eta="left" data-tip="Usually 3:30, from the last 10 runs">ETA ~1:20</);
});

test("running time says it is taking longer once the usual time is past", () => {
  const html = render({ expectedSeconds: 100, expectedSamples: 3 }, 130);
  assert.match(html, /data-eta="over" data-tip="Usually 1:40, from the last 3 runs">Taking longer</);
  assert.doesNotMatch(html, /ETA/);
});

test("running time with no history shows only the elapsed time", () => {
  const html = render({}, 130);
  assert.match(html, />2:10</);
  assert.doesNotMatch(html, /c-eta/);
});

test("the flashbar item carries the operation's expectation", () => {
  const model = { flash: { operations: [
    { id: "a", label: "Starting", worldName: "Alpha", worldId: "w1", startedAt: since, expectedSeconds: 90, expectedSamples: 5 },
  ] } } as unknown as ShellModel;
  const [item] = flashItems(model, queue, "w2");
  assert.deepEqual(item?.expectation, { expectedSeconds: 90, expectedSamples: 5 });
  // On the operation's own world the hero owns the time (R3).
  assert.equal(flashItems(model, queue, "w1")[0]?.since, undefined);
});
