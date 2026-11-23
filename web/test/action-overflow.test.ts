import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import { Overflow as ConsoleOverflow } from "../src/skins/console/ui/Overflow.tsx";
import { Overflow as TerminalOverflow } from "../src/skins/terminal/ui.tsx";
import { noop } from "./support/fixtures.ts";

const refresh = action("refresh", "Refresh", noop, { icon: "refresh" });
const archive = action("world.archive", "Archive", noop, { icon: "archive" });
const purge = action("world.purge", "Delete permanently", noop, { danger: true, icon: "delete_forever" });
const plain = action("world.open", "View details", noop);

// The console's Overflow is the row's one action column: always a menu, so
// every row of a column has the same control (owner rule 4).
test("console: one action still opens a menu, so a column keeps one control", () => {
  const markup = renderToStaticMarkup(createElement(ConsoleOverflow, { actions: [refresh], label: "World actions" }));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-label="World actions"/);
  assert.match(markup, /data-action="refresh"/);
  assert.match(markup, /role="menu"[^>]*popover="manual"|popover="manual"[^>]*role="menu"/);
});

test("console: a danger Action sits in its own last group, under a rule", () => {
  const markup = renderToStaticMarkup(createElement(ConsoleOverflow, { actions: [purge, archive], label: "World actions" }));
  const archiveAt = markup.indexOf('data-action="world.archive"');
  const purgeAt = markup.indexOf('data-action="world.purge"');
  assert.ok(archiveAt > 0 && purgeAt > archiveAt, "the danger item comes last");
  assert.match(markup.slice(archiveAt, purgeAt), /c-menu-group-split/);
  assert.match(markup, /c-menu-item c-menu-item-danger/);
});

test("console: a refused Action stays in the menu", () => {
  const markup = renderToStaticMarkup(createElement(ConsoleOverflow, { actions: [action("world.wipe", "Wipe", noop, { disabled: true, hint: "Needs a built release" })], label: "World actions" }));
  assert.match(markup, /data-action="world.wipe"/);
  assert.match(markup, /aria-disabled="true"/);
});

test("console: no Action draws no trigger", () => {
  assert.equal(renderToStaticMarkup(createElement(ConsoleOverflow, { actions: [], label: "World actions" })), "");
});

const terminal = (groups: readonly (readonly ReturnType<typeof action>[])[], menu = false) => createElement(TerminalOverflow, { groups, label: "World actions", menu });

test("terminal: one action is its own icon button, not a menu of one", () => {
  const markup = renderToStaticMarkup(terminal([[refresh]]));
  assert.match(markup, /data-action="refresh"/);
  assert.match(markup, /aria-label="Refresh"/);
  assert.doesNotMatch(markup, /role="menu"/);
  assert.doesNotMatch(markup, /aria-haspopup/);
});

test("terminal: two actions share a menu, each still reachable by its id", () => {
  const markup = renderToStaticMarkup(terminal([[refresh], [archive]]));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-label="World actions"/);
  assert.match(markup, /role="menu"/);
  assert.match(markup, /data-action="refresh"/);
  assert.match(markup, /data-action="world.archive"/);
});

test("terminal: a column that asks for the menu keeps it for one action with an icon", () => {
  const markup = renderToStaticMarkup(terminal([[refresh], []], true));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-label="World actions"/);
  assert.match(markup, /data-action="refresh"/);
});

test("terminal: one action without an icon keeps the menu", () => {
  const markup = renderToStaticMarkup(terminal([[plain]]));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /data-action="world.open"/);
});
