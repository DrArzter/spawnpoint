import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Address, Indicator, Person, Skeleton, SkeletonGroup, Table } from "../src/skins/terminal/ui.tsx";

test("terminal dense status keeps one visible mark and an accessible label", () => {
  const markup = renderToStaticMarkup(createElement(Indicator, { kind: "ok", label: "Verified" }));
  assert.match(markup, /t-indicator/);
  assert.match(markup, /t-mark-ok/);
  assert.match(markup, /visually-hidden[^>]*>Verified/);
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
