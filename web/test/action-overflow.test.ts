import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import { ActionOverflow } from "../src/skins/console/actions.tsx";
import { Overflow } from "../src/skins/terminal/ui.tsx";

const noop = () => undefined;
const refresh = action("refresh", "Refresh", noop, { icon: "refresh" });
const archive = action("world.archive", "Archive", noop, { icon: "archive" });
const plain = action("world.open", "View details", noop);

const skins = [
  ["console", (groups: readonly (readonly ReturnType<typeof action>[])[]) => createElement(ActionOverflow, { groups, label: "World actions" })],
  ["terminal", (groups: readonly (readonly ReturnType<typeof action>[])[]) => createElement(Overflow, { groups, label: "World actions" })],
] as const;

for (const [skin, overflow] of skins) {
  test(`${skin}: one action is its own icon button, not a menu of one`, () => {
    const markup = renderToStaticMarkup(overflow([[refresh]]));
    assert.match(markup, /data-action="refresh"/);
    assert.match(markup, /aria-label="Refresh"/);
    assert.doesNotMatch(markup, /role="menu"/);
    assert.doesNotMatch(markup, /aria-haspopup/);
  });

  test(`${skin}: two actions share a menu, each still reachable by its id`, () => {
    const markup = renderToStaticMarkup(overflow([[refresh], [archive]]));
    assert.match(markup, /aria-haspopup="menu"/);
    assert.match(markup, /aria-label="World actions"/);
    assert.match(markup, /role="menu"/);
    assert.match(markup, /data-action="refresh"/);
    assert.match(markup, /data-action="world.archive"/);
  });

  test(`${skin}: one action without an icon keeps the menu`, () => {
    const markup = renderToStaticMarkup(overflow([[plain]]));
    assert.match(markup, /aria-haspopup="menu"/);
    assert.match(markup, /data-action="world.open"/);
  });
}
