import "./support/browser.ts";

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { OperationProgress } from "../src/api/contract.ts";
import { progressModel } from "../src/core/operation-progress.ts";
import type { Operation } from "../src/model.ts";
import { OperationProgress as ConsoleProgress } from "../src/skins/console/OperationProgress.tsx";
import { World as TerminalWorld } from "../src/skins/terminal/World.tsx";

/*
 * The operation's progress in both skins: the same rows from one model, a
 * status mark once, and a failure with its whole cause.
 */

const START = Date.parse("2026-11-21T12:00:00.000Z");
const startedAt = new Date(START).toISOString();
const live: Operation = { id: "op-1", type: "promote", status: "running", startedAt, worldId: "w1", expectedSeconds: 60, expectedSamples: 4 };
const running: OperationProgress = {
  id: "op-1", type: "promote", status: "running", startedAt, stoppedAt: null, elapsedSeconds: 42, expectedSeconds: 60, expectedSamples: 4,
  step: { key: "promote.starting_release", label: "Starting on the new release" },
  child: { type: "start", step: { key: "start.waiting_host", label: "Waiting for the host" } },
  result: null, failure: null, caught: null,
};
const LONG = `${"The host could not be launched because capacity ran out. ".repeat(6)}End.`;
const failed: OperationProgress = {
  ...running, status: "failed", stoppedAt: new Date(START + 30_000).toISOString(), elapsedSeconds: 30, step: null, child: null,
  failure: { error: "Ec2.InsufficientInstanceCapacity", cause: LONG },
  caught: { error: "SessionStartFailed", cause: "The host never reported ready.", step: { key: "promote.starting_release", label: "Starting on the new release" } },
};

const count = (markup: string, pattern: RegExp) => markup.match(new RegExp(pattern.source, "g"))?.length ?? 0;
const runningModel = () => progressModel(live, running)!;
const failedModel = () => progressModel(null, failed)!;

function render(element: ReturnType<typeof createElement>, seconds: number): string {
  mock.timers.enable({ apis: ["Date"], now: START + seconds * 1000 });
  try {
    return renderToStaticMarkup(element);
  } finally {
    mock.timers.reset();
  }
}

afterEach(() => { mock.timers.reset(); });

test("console: a running operation is a card with one busy status, its step, sub-step, elapsed time and ETA", () => {
  const markup = render(createElement(ConsoleProgress, { model: runningModel() }), 42);
  assert.match(markup, /<h2[^>]*>Promoting release<\/h2>/);
  assert.equal(count(markup, /data-status="progress"/), 1);
  assert.match(markup, /<dl aria-label="Promoting release: Running"/);
  for (const text of ["Step", "Starting on the new release", "Sub-step", "Waiting for the host", "Elapsed", "0:42", "Expected", "ETA ~0:18"]) assert.ok(markup.includes(text), text);
  assert.match(markup, /Usually 1:00, from the last 4 runs/);
  assert.doesNotMatch(markup, /data-status="error"/);
});

test("console: a failure keeps its status once, the error and the whole cause, and what was caught", () => {
  const markup = render(createElement(ConsoleProgress, { model: failedModel() }), 900);
  assert.equal(count(markup, /data-status="/), 1);
  assert.match(markup, /data-status="error"/);
  assert.ok(markup.includes("Ec2.InsufficientInstanceCapacity"));
  assert.ok(markup.includes(LONG), "the cause is whole in the page");
  assert.match(markup, /class="c-detail-wrap" title="The host could not/);
  for (const text of ["SessionStartFailed", "The host never reported ready.", "Caught at", "Starting on the new release", "0:30"]) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /ETA|Taking longer/);
});

// The terminal draws the panel inside its world page; the rest of the model is the minimum the page reads.
const noop = () => undefined;
const act = { id: "x", label: "X", run: noop, disabled: false, busy: false };
function terminalPage(progress: ReturnType<typeof progressModel>): string {
  const world = { id: "w1", displayName: "Creative", wipes: [] };
  const model = {
    game: { id: "g", displayName: "Minecraft" }, world, worldsHref: "#/worlds", sessionStatus: { kind: "off", label: "Stopped" }, notices: [],
    tabs: [{ id: "details", label: "Details" }], tab: "details", setTab: noop, session: act, refresh: act, invite: null, more: [],
    sessionDetails: [], worldDetails: [], operations: [], progress,
  };
  return render(createElement(TerminalWorld, { model: model as never }), 42);
}

test("terminal: a running operation is a named panel with one busy state and the same rows", () => {
  const markup = terminalPage(runningModel());
  assert.match(markup, /<h2 class="t-panel-name"[^>]*>Promoting release<\/h2>/);
  assert.equal(count(markup, /t-state-progress/), 1);
  assert.match(markup, /aria-label="Promoting release: Running"/);
  for (const text of ["Step", "Starting on the new release", "Sub-step", "Waiting for the host", "Elapsed", "0:42", "Expected", "ETA ~0:18"]) assert.ok(markup.includes(text), text);
});

test("terminal: a failure shows one error state, the error, the whole cause and what was caught", () => {
  const markup = terminalPage(failedModel());
  assert.equal(count(markup, /t-state-error/), 1);
  assert.ok(markup.includes("Ec2.InsufficientInstanceCapacity"));
  assert.ok(markup.includes(LONG));
  for (const text of ["SessionStartFailed", "The host never reported ready.", "Caught at"]) assert.ok(markup.includes(text), text);
});

test("terminal: no progress, no panel", () => {
  assert.doesNotMatch(terminalPage(null), /Promoting release/);
});
