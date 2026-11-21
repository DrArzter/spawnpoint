import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { dropSnack, enqueue, SnackbarProvider, useSnackbarQueue, type SnackbarQueue } from "../src/components/ui/Snackbar.tsx";

// M9: a skin may draw the notification queue itself. Without `render` the
// default host is drawn as before; with it, the queue reaches the skin and
// the default host is not drawn.

test("without render, the provider draws its default host", () => {
  const markup = renderToStaticMarkup(createElement(SnackbarProvider, null, "page"));
  assert.match(markup, /class="snackbar-host"/);
  assert.match(markup, /aria-label="Notifications"/);
});

test("with render, the queue reaches the skin and the default host is not drawn", () => {
  let seen: SnackbarQueue | null = null;
  const markup = renderToStaticMarkup(createElement(SnackbarProvider, { render: (queue: SnackbarQueue) => { seen = queue; return createElement("output", null, `${queue.items.length} items`); } }, "page"));
  assert.doesNotMatch(markup, /snackbar-host/);
  assert.match(markup, /<output>0 items<\/output>/);
  assert.equal(typeof (seen as SnackbarQueue | null)?.dismiss, "function");
});

test("a view inside the provider reads the same queue", () => {
  function Reader() {
    return createElement("span", null, `queue ${useSnackbarQueue().items.length}`);
  }
  assert.match(renderToStaticMarkup(createElement(SnackbarProvider, { render: () => null }, createElement(Reader))), /queue 0/);
});

test("the queue keeps the newest three and dismiss drops one by id", () => {
  let queue = enqueue([], { message: "one" }, 1);
  queue = enqueue(queue, { message: "two", tone: "error" }, 2);
  queue = enqueue(queue, { message: "three" }, 3);
  queue = enqueue(queue, { message: "four" }, 4);
  assert.deepEqual(queue.map((snack) => snack.message), ["two", "three", "four"]);
  assert.equal(queue[0]!.tone, "error");
  assert.equal(queue[1]!.tone, "info", "a snack without a tone is info");
  assert.deepEqual(dropSnack(queue, 3).map((snack) => snack.id), [2, 4]);
});
