import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import { Card } from "../src/skins/console/ui/Card.tsx";
import { DetailList } from "../src/skins/console/ui/DetailList.tsx";
import { Empty } from "../src/skins/console/ui/Empty.tsx";
import { TopBar } from "../src/skins/console/ui/Frame.tsx";
import { Grid } from "../src/skins/console/ui/Grid.tsx";
import { Indicator } from "../src/skins/console/ui/Indicator.tsx";
import { Menu } from "../src/skins/console/ui/Menu.tsx";
import { PageHeader } from "../src/skins/console/ui/PageHeader.tsx";
import { Status } from "../src/skins/console/ui/Status.tsx";
import { Table } from "../src/skins/console/ui/Table.tsx";
import { Tabs } from "../src/skins/console/ui/Tabs.tsx";
import { TrackList } from "../src/skins/console/ui/TrackList.tsx";
import { aGame, aShell, noop } from "./support/fixtures.ts";

/*
 * The layout markers the UI gate reads (web/tools/ui-audit/probe.js). A
 * primitive that promises a layout says so in its markup, so every page that
 * uses it is held to the promise without a class list in the gate.
 */

const html = (element: ReactElement) => renderToStaticMarkup(element);

test("markers: the page header is one spread line and its breadcrumb is marked", () => {
  const markup = html(createElement(PageHeader, { trail: [{ label: "Minecraft", href: "#/worlds/minecraft" }], title: "Worlds", actions: createElement("button", null, "Create") }));
  assert.match(markup, /<header class="c-page-header" data-from="760" data-layout="one-line spread">/);
  assert.match(markup, /<nav aria-label="Breadcrumb" class="c-crumbs" data-layout="crumbs">/);
});

test("markers: a card is a rail and a scope; its head spreads only with actions", () => {
  const plain = html(createElement(Card, { title: "Host" }, "body"));
  assert.match(plain, /<section class="c-card" data-layout="rail" data-scope="">/);
  assert.match(plain, /<h2 data-rail="">/);
  assert.doesNotMatch(plain, /c-card-head" data-layout/);
  const acting = html(createElement(Card, { title: "Host", actions: createElement("button", null, "Edit") }, "body"));
  assert.match(acting, /<header class="c-card-head" data-layout="spread">/);
});

test("markers: a table is a list of rows with one action column and a rail start", () => {
  const markup = html(createElement(Table<{ id: string }>, {
    label: "Worlds",
    rows: [{ id: "a" }, { id: "b" }],
    rowKey: (row) => row.id,
    columns: [
      { id: "name", header: "Name", kind: "lead", render: (row) => row.id },
      { id: "state", header: "State", render: () => "On" },
      { id: "act", header: "Actions", kind: "act", render: () => createElement("button", null, "x") },
    ],
  }));
  assert.match(markup, /<table aria-label="Worlds" class="c-table" data-layout="rows">/);
  assert.equal(markup.match(/data-col="actions"/g)?.length, 3, "the header and both rows mark their one action cell");
  assert.equal(markup.match(/data-rail=""/g)?.length, 3, "the first cell of the header and of each row starts the rail");
});

test("markers: a track list is rows, one line from 1024px", () => {
  const markup = html(createElement(TrackList<{ id: string }>, {
    label: "Releases",
    rows: [{ id: "a" }],
    rowKey: (row) => row.id,
    tracks: [{ id: "name", header: "Name", width: "1fr", render: (row) => row.id }, { id: "n", header: "N", width: "80px", kind: "num", render: () => "1" }],
  }));
  assert.match(markup, /data-layout="rows" role="table"/);
  assert.match(markup, /data-from="1024" data-layout="one-line" role="row"/);
});

test("markers: details are pairs, an empty state is centred, a grid is a grid", () => {
  assert.match(html(createElement(DetailList, { details: [{ label: "Address", value: { type: "text", text: "a" } }] })), /class="c-detail-item" data-layout="pair"/);
  assert.match(html(createElement(Empty, { icon: "info", title: "No worlds" })), /class="c-empty" data-layout="centred"/);
  assert.match(html(createElement(Grid, { kind: "home" }, "x")), /class="c-grid c-grid-home" data-layout="grid"/);
});

test("markers: a status and a status indicator name their state; a plain fact does not", () => {
  assert.match(html(createElement(Status, { status: { kind: "ok", label: "Online" } })), /data-status="ok"/);
  assert.match(html(createElement(Indicator, { status: { kind: "warning", label: "Behind" } })), /data-status="warning"/);
  assert.doesNotMatch(html(createElement(Indicator, { icon: "dns", label: "Persistent" })), /data-status/);
});

test("markers: menus are their own layer; the tab ink is a glyph laid over its tab", () => {
  const anchor = { current: null };
  assert.match(html(createElement(Menu, { id: "m", label: "More", groups: [{ actions: [action("a", "A", noop)] }], open: false, anchor, onClose: noop })), /class="c-menu" data-layer="menu"/);
  const tabs = html(createElement(Tabs<"a" | "b">, { label: "World", prefix: "w", tabs: [{ id: "a", label: "A" }, { id: "b", label: "B" }], value: "a", onChange: noop }));
  assert.match(tabs, /class="c-tab-ink" data-layer="glyph"/);
});

// Owner rules that the markup alone decides.

test("rule 1: header slots carry no explanatory paragraph", () => {
  const header = html(createElement(PageHeader, { trail: [{ label: "Minecraft", href: "#/worlds/minecraft" }], title: "Worlds", count: 2, after: createElement("span", null, "x"), actions: createElement("button", null, "y") }));
  const card = html(createElement(Card, { title: "Host", meta: "· 3 players", actions: createElement("button", null, "Edit") }, "body"));
  assert.doesNotMatch(header, /<p[\s>]/);
  assert.doesNotMatch(card.slice(0, card.indexOf("c-card-body")), /<p[\s>]/);
});

test("rule 6: the breadcrumb's last item is the one h1, and no crumb repeats it", () => {
  const markup = html(createElement(PageHeader, { trail: [{ label: "Minecraft", href: "#/worlds/minecraft" }, { label: "Worlds", href: "#/worlds/minecraft" }], title: "Rostik" }));
  assert.equal(markup.match(/<h1/g)?.length, 1);
  assert.match(markup, /<nav[^>]*data-layout="crumbs">.*<h1[^>]*>Rostik<\/h1><\/nav>/);
  assert.doesNotMatch(markup.slice(0, markup.indexOf("<h1")), />Rostik</);
});

test("rule 7: the top bar holds no theme control", () => {
  const model = aShell(aGame(), {
    navigation: [],
    page: "worlds",
    viewer: { displayName: "DrArzter", inTelegram: false },
    demo: true,
    observedAt: "Sep 23, 2026, 2:01 PM",
    openProfile: action("shell.profile", "Open my profile", noop),
    observedAtIso: "2026-09-23T14:01:00Z",
    refreshAction: () => action("refresh", "Refresh", noop),
    appearance: { preference: "system", theme: "light", accent: "#1a73e8", label: "System theme (light)", setPreference: async () => undefined, setAccent: async () => undefined },
  });
  const markup = html(createElement(TopBar, { model, scope: null, onSearch: noop }));
  assert.match(markup, /class="c-topbar"/);
  assert.doesNotMatch(markup, /theme|dark mode|light mode|appearance|contrast/i);
});
