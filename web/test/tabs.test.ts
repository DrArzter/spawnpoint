import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Tabs } from "../src/components/ui/Tabs.tsx";
import { revealDelta } from "../src/lib/revealTab.ts";
import { Tabs as TerminalTabs } from "../src/skins/terminal/ui.tsx";

// A world page has six tabs; on a phone the strip scrolls, and the open one
// must not sit past its edge.

test("a tab past the strip's edge is scrolled in, and only as far as needed", () => {
  const strip = { left: 16, right: 359 };
  assert.equal(revealDelta(strip, { left: 40, right: 120 }), 0, "a visible tab leaves the strip still");
  assert.equal(revealDelta(strip, { left: 420, right: 500 }), 141, "a tab past the right edge comes in to it");
  assert.equal(revealDelta(strip, { left: -60, right: 10 }), -76, "a tab past the left edge comes in to it");
  assert.equal(revealDelta(strip, { left: 300, right: 700 }), 284, "a tab wider than the strip shows its start");
});

test("both faces draw a scrolling tablist with one selected, focusable tab", () => {
  const options = [{ id: "details", label: "Details" }, { id: "metrics", label: "Metrics" }] as const;
  for (const Strip of [Tabs, TerminalTabs]) {
    const markup = renderToStaticMarkup(createElement(Strip, { label: "World", options, value: "metrics", onChange: () => undefined }));
    assert.match(markup, /role="tablist"/);
    assert.match(markup, /aria-label="World"/);
    assert.match(markup, /data-scroll="expected"/);
    assert.equal(markup.match(/aria-selected="true"/g)?.length, 1);
    assert.match(markup, /aria-selected="true"[^>]*tabindex="0"[^>]*>Metrics/);
  }
});
