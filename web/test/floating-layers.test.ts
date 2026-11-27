import "./support/browser.ts";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SnackbarProvider } from "../src/components/ui/Snackbar.tsx";
import { Tooltip } from "../src/components/ui/Tooltip.tsx";
import { Menu } from "../src/skins/console/ui/Menu.tsx";
import { ToastProvider } from "../src/skins/console/ui/Toast.tsx";
import { TooltipLayer } from "../src/skins/console/ui/Tooltip.tsx";
import { skinEnabled } from "./support/skins.ts";

// Every floating layer (tip, menu, toast) is a manual popover shown through
// components/ui/layer.ts. A modal dialog is in the top layer, and only another
// top-layer element can sit above it. The UI gate proves the stacking in a
// browser (tools/ui-audit, states layers-*); this holds the markup and the
// one code path.

const root = new URL("../src/", import.meta.url).pathname;
const LAYER = "components/ui/layer.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(root).map((path) => ({ name: relative(root, path), text: readFileSync(path, "utf8") }));

// The opening tag a marker sits in: from the last "<tag" before it to the next line end.
function tagsWith(text: string, marker: RegExp): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(marker)) {
    const start = text.lastIndexOf("<", match.index);
    const end = text.indexOf("\n", match.index);
    found.push(text.slice(start, end < 0 ? undefined : end));
  }
  return found;
}

test("every layer the code draws is a manual popover and its file uses the shared mechanism", () => {
  const marker = /data-layer="(?:tip|menu|toast)"/g;
  let layers = 0;
  for (const { name, text } of sources) {
    const tags = tagsWith(text, marker);
    layers += tags.length;
    for (const tag of tags) assert.match(tag, /popover="manual"/, `${name}: ${tag.slice(0, 80)}`);
    if (tags.length > 0) assert.match(text, /from "(?:\.\.\/)+(?:components\/ui\/)?layer"|from "\.\/layer"/, `${name} does not import the layer mechanism`);
  }
  assert.ok(layers >= 6, `expected the tip, menu and toast layers of both skins, found ${layers}`);
});

test("a popover is always a marked layer, never light-dismiss, and only layer.ts opens one", () => {
  for (const { name, text } of sources) {
    if (name === LAYER) continue;
    assert.doesNotMatch(text, /popover="auto"/, `${name} uses a light-dismiss popover`);
    assert.doesNotMatch(text, /\.(?:show|hide)Popover\(/, `${name} calls the Popover API directly`);
    for (const tag of tagsWith(text, /popover="manual"/g)) assert.match(tag, /data-layer="(?:tip|menu|toast)"/, `${name}: popover without data-layer: ${tag.slice(0, 80)}`);
  }
});

test("the rendered layers carry the popover attribute", () => {
  assert.match(renderToStaticMarkup(createElement(SnackbarProvider, null, "page")), /<section[^>]*data-layer="toast"[^>]*popover="manual"/);
  assert.match(renderToStaticMarkup(createElement(ToastProvider, null, "page")), /data-layer="toast"[^>]*popover="manual"/);
  assert.match(renderToStaticMarkup(createElement(TooltipLayer)), /data-layer="tip"[^>]*popover="manual"/);
  const menu = createElement(Menu, { id: "m", label: "More", groups: [], open: false, anchor: { current: null }, onClose: () => undefined });
  assert.match(renderToStaticMarkup(menu), /data-layer="menu"[^>]*popover="manual"/);
  // The shared tooltip draws its tip only while it shows; the anchor itself is no layer.
  assert.doesNotMatch(renderToStaticMarkup(createElement(Tooltip, { text: "Why" }, "x")), /data-layer/);
});

test("the layers' stylesheet owners keep no stacking of their own", () => {
  // A switched-off skin's sheet is not checked (ADR-0106).
  const terminal = skinEnabled("terminal") ? ["skins/terminal/terminal.css"] : [];
  for (const sheet of ["styles/components.css", "skins/console/styles/menu.css", "skins/console/styles/notify.css", ...terminal]) {
    const text = readFileSync(join(root, sheet), "utf8");
    for (const selector of [".tip ", ".menu ", ".snackbar-host ", ".c-menu ", ".c-toasts ", ".c-tip ", ".t-menu "]) {
      const at = text.indexOf(`${selector}{`);
      if (at < 0) continue;
      const block = text.slice(at, text.indexOf("}", at));
      assert.doesNotMatch(block, /z-index/, `${sheet}: ${selector}sets z-index`);
    }
  }
});
