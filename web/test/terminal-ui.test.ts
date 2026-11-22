import "./support/browser.ts";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Address, FilterRow, Indicator, NoMatches, Pager, Person, Skeleton, SkeletonGroup, Table } from "../src/skins/terminal/ui.tsx";

test("terminal dense status keeps one visible mark and an accessible label", () => {
  const markup = renderToStaticMarkup(createElement(Indicator, { kind: "ok", label: "Verified" }));
  assert.match(markup, /t-indicator/);
  assert.match(markup, /t-mark-ok/);
  assert.match(markup, /visually-hidden[^>]*>Verified/);
});

test("a terminal indicator for a plain fact names its own glyph, with no status tone and the word in its label", () => {
  const markup = renderToStaticMarkup(createElement(Indicator, { glyph: "M", label: "Modrinth" }));
  assert.match(markup, /t-indicator/);
  assert.match(markup, /<span aria-hidden="true" class="t-mark">\[M\]<\/span>/);
  assert.doesNotMatch(markup, /t-mark-/);
  assert.match(markup, /visually-hidden[^>]*>Modrinth/);
});

test("a terminal filter row holds the choices that narrow its list beside the search field", () => {
  const filter = { query: "", setQuery: () => undefined, clear: () => undefined, active: false, rows: [], total: 0, field: { current: null } };
  const markup = renderToStaticMarkup(createElement(FilterRow, { filter, label: "Search mods", placeholder: "Search by file name" }, createElement("fieldset", { className: "t-choices" })));
  assert.match(markup, /<\/label><fieldset class="t-choices">/);
});

test("a terminal filter row counts what the server matched when it is told, and what survived otherwise", () => {
  const filter = { query: "cre", setQuery: () => undefined, clear: () => undefined, active: true, rows: [1, 2], total: 9, field: { current: null } };
  assert.match(renderToStaticMarkup(createElement(FilterRow, { filter, label: "Search", placeholder: "Search", matches: 4 })), /role="status">4 of 9</);
  assert.match(renderToStaticMarkup(createElement(FilterRow, { filter, label: "Search", placeholder: "Search" })), /role="status">2 of 9</);
});

test("a terminal pager is drawn only for more than one page, names the place, and disables the ends", () => {
  assert.equal(renderToStaticMarkup(createElement(Pager, { page: 1, pages: 1, onPage: () => undefined })), "");
  const first = renderToStaticMarkup(createElement(Pager, { page: 1, pages: 4, onPage: () => undefined, label: "Mod pages" }));
  assert.match(first, /<nav aria-label="Mod pages" class="t-pager">/);
  assert.match(first, /aria-current="page"[^>]*>Page 1 of 4</);
  assert.match(first, /aria-label="Previous page"[^>]*disabled=""|disabled=""[^>]*aria-label="Previous page"/);
  assert.doesNotMatch(first, /aria-label="Next page"[^>]*disabled/);
  const last = renderToStaticMarkup(createElement(Pager, { page: 4, pages: 4, onPage: () => undefined }));
  assert.match(last, /aria-label="Next page"[^>]*disabled=""|disabled=""[^>]*aria-label="Next page"/);
  assert.match(last, /t-verb-icon-only/, "both ends are the shared icon key");
});

test("a terminal list that a filter emptied says what it was asked only when something was typed, and names its way back", () => {
  const typed = renderToStaticMarkup(createElement(NoMatches, { filter: { query: "pine", clear: () => undefined }, noun: "mods" }));
  assert.match(typed, /Nothing matches &quot;pine&quot;/);
  assert.match(typed, />Clear search</);
  const chosen = renderToStaticMarkup(createElement(NoMatches, { filter: { query: "", clear: () => undefined }, noun: "mods", clearLabel: "Clear filters" }));
  assert.doesNotMatch(chosen, /Nothing matches/);
  assert.match(chosen, />Clear filters</);
});

test("terminal person is the shared avatar, name and optional detail row", () => {
  const markup = renderToStaticMarkup(createElement(Person, { name: "Nikita", detail: "@nikita" }));
  assert.match(markup, /t-person/);
  assert.match(markup, /t-avatar/);
  assert.match(markup, /<strong>Nikita<\/strong>/);
  assert.match(markup, /<small>@nikita<\/small>/);
});

test("terminal decision tables expose their shared compact layout variant", () => {
  const markup = renderToStaticMarkup(createElement(Table<{ id: string }>, {
    columns: [{ id: "user", label: "User", render: (row) => row.id }],
    decision: true,
    empty: "Empty",
    headless: true,
    label: "People",
    rowKey: (row) => row.id,
    rows: [{ id: "one" }],
  }));
  assert.match(markup, /t-table-wrap t-table-decision/);
});

test("a terminal table column of long copied values is the truncating column, head and cells alike", () => {
  const markup = renderToStaticMarkup(createElement(Table<{ id: string }>, {
    columns: [
      { id: "archive", label: "Archive", truncate: true, render: (row) => createElement("code", { className: "t-clip" }, row.id) },
      { id: "size", label: "Size", render: () => "1 MiB" },
    ],
    empty: "Empty",
    label: "Backups",
    rowKey: (row) => row.id,
    rows: [{ id: "world-2026-10-26.tar.zst" }],
  }));
  assert.match(markup, /<th class="t-truncate"[^>]*>Archive<\/th>/);
  assert.match(markup, /<td class="t-truncate" data-label="Archive"><code class="t-clip">world-2026-10-26\.tar\.zst<\/code><\/td>/);
  assert.match(markup, /<td class="" data-label="Size">/);
});

test("terminal address keeps network, value and copy key in one component", () => {
  const markup = renderToStaticMarkup(createElement(Address, {
    connectivity: "zerotier",
    copyLabel: "Copy address",
    network: "ZeroTier network",
    value: "172.29.23.24:25565",
  }));
  assert.match(markup, /t-address-net/);
  assert.match(markup, /t-address-value/);
  assert.match(markup, /t-copy/);
});

test("terminal skeleton announces one loading region and hides its visual traces", () => {
  const markup = renderToStaticMarkup(createElement(SkeletonGroup, {
    label: "Reading metrics",
    children: createElement(Skeleton, { variant: "plot" }),
  }));
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /visually-hidden[^>]*>Reading metrics/);
  assert.match(markup, /t-skeleton-plot/);
  assert.equal((markup.match(/t-skeleton-trace/g) ?? []).length, 7);
});

test("terminal table loading preserves row and column geometry", () => {
  const markup = renderToStaticMarkup(createElement(Table<{ id: string }>, {
    columns: [
      { id: "name", label: "Name", render: (row) => row.id },
      { id: "status", label: "Status", render: () => "Ready" },
    ],
    empty: "Empty",
    label: "Worlds",
    loading: true,
    loadingRows: 2,
    rowKey: (row) => row.id,
    rows: [],
  }));
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /aria-label="Worlds\. Loading worlds"/);
  assert.equal((markup.match(/t-table-skeleton/g) ?? []).length, 2);
  assert.equal((markup.match(/t-skeleton-text/g) ?? []).length, 4);
});

test("a terminal table row's link is a real anchor whose hit area is the row, and keys stay above it", () => {
  const markup = renderToStaticMarkup(createElement(Table<{ id: string }>, {
    columns: [
      { id: "name", label: "Name", render: (row) => createElement("a", { className: "t-row-link", href: `#/${row.id}` }, row.id) },
      { id: "act", label: "Actions", render: () => createElement("button", { type: "button" }, "Open") },
    ],
    empty: "Empty",
    label: "Worlds",
    rowKey: (row) => row.id,
    rows: [{ id: "one" }],
  }));
  assert.match(markup, /<td[^>]*><a class="t-row-link" href="#\/one">one<\/a><\/td>/);
  assert.match(markup, /<td[^>]*><button type="button">Open<\/button><\/td>/);
  const css = readFileSync(new URL("../src/skins/terminal/terminal.css", import.meta.url), "utf8");
  assert.match(css, /\.t-table \.t-row-link::after \{\s*position: absolute;\s*inset: 0;/);
  assert.match(css, /\.t-table tr \{\s*position: relative;/);
  assert.match(css, /\.t-table :is\(button, select, label, input, \.t-indicator, a:not\(\.t-row-link\)\) \{\s*position: relative;\s*z-index: 1;/);
});
