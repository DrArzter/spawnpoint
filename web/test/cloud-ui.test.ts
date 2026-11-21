import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import type { ShellModel } from "../src/core/models.ts";
import { flashItems, pageKey, transitionKind } from "../src/skins/cloud/Shell.tsx";
import { ActionButton, LinkButton } from "../src/skins/cloud/ui/ActionButton.tsx";
import { Address } from "../src/skins/cloud/ui/Address.tsx";
import { relativeTime } from "../src/skins/cloud/ui/Ago.tsx";
import { Card } from "../src/skins/cloud/ui/Card.tsx";
import { Copy } from "../src/skins/cloud/ui/Copy.tsx";
import { DetailList } from "../src/skins/cloud/ui/DetailList.tsx";
import { Dialog } from "../src/skins/cloud/ui/Dialog.tsx";
import { Empty, LoadError } from "../src/skins/cloud/ui/Empty.tsx";
import { Checkbox, Field, RadioCards, Select, TextInput, Toggle } from "../src/skins/cloud/ui/Fields.tsx";
import { applyFilter, FilterBar } from "../src/skins/cloud/ui/FilterBar.tsx";
import { elapsed } from "../src/skins/cloud/ui/Flashbar.tsx";
import { frameItems } from "../src/skins/cloud/ui/Frame.tsx";
import { Grid } from "../src/skins/cloud/ui/Grid.tsx";
import { Indicator } from "../src/skins/cloud/ui/Indicator.tsx";
import { MenuButton } from "../src/skins/cloud/ui/MenuButton.tsx";
import { ListColumn, ListItemIcon, ListItemPerson, ListItemWorld } from "../src/skins/cloud/ui/ListColumn.tsx";
import { Notice } from "../src/skins/cloud/ui/Notice.tsx";
import { Overflow } from "../src/skins/cloud/ui/Overflow.tsx";
import { PageHeader } from "../src/skins/cloud/ui/PageHeader.tsx";
import { pageOf, Pager } from "../src/skins/cloud/ui/Pager.tsx";
import { Person } from "../src/skins/cloud/ui/Person.tsx";
import { TablePreferences } from "../src/skins/cloud/ui/Preferences.tsx";
import { Segmented } from "../src/skins/cloud/ui/Segmented.tsx";
import { SidePanel } from "../src/skins/cloud/ui/SidePanel.tsx";
import { Skeleton, SkeletonGroup, SkeletonRows } from "../src/skins/cloud/ui/Skeleton.tsx";
import { SplitPage } from "../src/skins/cloud/ui/SplitPage.tsx";
import { StatCard } from "../src/skins/cloud/ui/StatCard.tsx";
import { Status } from "../src/skins/cloud/ui/Status.tsx";
import { nextSort, Table } from "../src/skins/cloud/ui/Table.tsx";
import { TabPanel, Tabs } from "../src/skins/cloud/ui/Tabs.tsx";
import { Tick } from "../src/skins/cloud/ui/Tick.tsx";
import { Tile, Tiles } from "../src/skins/cloud/ui/Tile.tsx";
import { TrackList, TrackTitle } from "../src/skins/cloud/ui/TrackList.tsx";

// The cloud primitives' contracts: semantic markup, accessible names, stable
// classes and every Action reachable with its data-action (AGENTS.md).

const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

test("ActionButton: a refused action stays focusable, says why, and keeps its id", () => {
  const refused = html(createElement(ActionButton, { action: action("session.start", "Start", noop, { disabled: true, hint: "Your role cannot start sessions.", icon: "play_arrow" }), variant: "primary" }));
  assert.match(refused, /data-action="session.start"/);
  assert.match(refused, /aria-disabled="true"/);
  assert.doesNotMatch(refused, /\sdisabled=""/, "never the disabled attribute: it would drop focus and the tooltip");
  assert.match(refused, /data-tip="Your role cannot start sessions."/);
  assert.match(refused, /, unavailable: Your role cannot start sessions./);
  assert.match(refused, /class="c-btn c-btn-primary"/);
  const iconOnly = html(createElement(ActionButton, { action: action("refresh", "Refresh", noop, { icon: "refresh" }), iconOnly: true, size: "sm" }));
  assert.match(iconOnly, /aria-label="Refresh"/);
  assert.match(iconOnly, /c-btn-sm c-btn-icon/);
  assert.match(html(createElement(ActionButton, { action: action("x", "Save", noop, { busy: true }) })), /aria-busy="true"/);
  assert.match(html(createElement(LinkButton, { href: "#/worlds", label: "All worlds" })), /<a class="c-btn c-btn-default" href="#\/worlds">/);
});

test("Overflow: every item is in the markup while closed, danger items in a group of their own", () => {
  const markup = html(createElement(Overflow, { label: "More actions for Rostik", actions: [action("world.archive", "Archive", noop), action("world.purge", "Delete", noop, { danger: true }), action("world.wipe", "Wipe", noop, { disabled: true, hint: "Needs a built release" })] }));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-label="More actions for Rostik"/);
  assert.match(markup, /role="menu"[^>]*hidden=""|hidden=""[^>]*role="menu"/);
  for (const id of ["world.archive", "world.purge", "world.wipe"]) assert.match(markup, new RegExp(`data-action="${id}"`));
  assert.match(markup, /c-menu-group c-menu-group-split/);
  assert.match(markup, /c-menu-item c-menu-item-danger/);
  assert.equal(html(createElement(Overflow, { label: "x", actions: [] })), "", "nothing to offer draws nothing");
});

test("PageHeader: the breadcrumb is the title, with a back button for the phone", () => {
  const markup = html(createElement(PageHeader, { trail: [{ label: "Minecraft", href: "#/home/minecraft", game: true }, { label: "Worlds", href: "#/worlds/minecraft" }], title: "Rostik", count: 3, actions: "acts" }));
  assert.match(markup, /<nav aria-label="Breadcrumb"/);
  assert.match(markup, /<h1 aria-current="page" tabindex="-1" title="Rostik">Rostik<span class="c-count">3<\/span><\/h1>/);
  assert.match(markup, /aria-label="Back to Worlds"/);
  assert.match(markup, /c-crumb c-crumb-game/);
  assert.equal((markup.match(/<h1/g) ?? []).length, 1);
  assert.match(markup, /class="c-page-actions"/);
});

test("Card and Grid: the title at the start, actions at the end, a grid that stretches", () => {
  const card = html(createElement(Card, { title: "Session", count: 2, actions: "a", body: "flush" }, "body"));
  assert.match(card, /<section class="c-card" data-layout="rail" data-scope=""><header class="c-card-head" data-layout="spread"><h2 data-rail="">Session<span class="c-count"><span class="c-tick">2<\/span><\/span><\/h2><div class="c-card-actions">a<\/div>/);
  assert.match(card, /c-card-body c-card-body-flush/);
  assert.match(html(createElement(Card, { label: "Hero" }, "x")), /<section aria-label="Hero" class="c-card" data-layout="rail" data-scope="">/);
  assert.match(html(createElement(Grid, { kind: "chart" }, "x")), /class="c-grid c-grid-chart"/);
});

test("Status: an icon and a word in the state's tone, never colour alone", () => {
  assert.match(html(createElement(Status, { status: { kind: "ok", label: "Online" } })), /c-status c-status-text c-tone-ok.*Online/);
  assert.match(html(createElement(Status, { status: { kind: "progress", label: "Starting" }, variant: "pill" })), /c-status-pill c-tone-busy.*c-spin.*Starting/);
  assert.match(html(createElement(Status, { status: { kind: "archived", label: "Archived" } })), /c-tone-off/);
  assert.match(html(createElement(Status, { status: { kind: "unknown", label: "Unknown" } })), /c-tone-warn/);
});

test("Notice, Empty and LoadError: one line, one title, at most one Action", () => {
  const notice = html(createElement(Notice, { notice: { id: "load", tone: "error", title: "Current state could not be loaded", action: action("refresh.notice", "Try again", noop) } }));
  assert.match(notice, /role="alert"/);
  assert.match(notice, /data-action="refresh.notice"/);
  const empty = html(createElement(Empty, { icon: "public", title: "No worlds" }));
  assert.match(empty, /<div class="c-empty" data-layout="centred">/);
  assert.doesNotMatch(empty, /<p[\s>]/, "an empty state carries no description");
  const failed = html(createElement(LoadError, { title: "Backups could not be loaded", verb: "read backups", error: "boom", kind: "failed", retry: action("backups.retry", "Try again", noop) }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /data-action="backups.retry"/);
  assert.match(failed, /boom/);
  const forbidden = html(createElement(LoadError, { title: "x", verb: "read backups", error: "no", kind: "forbidden", retry: action("backups.retry", "Try again", noop) }));
  assert.match(forbidden, /Your role cannot read backups/);
  assert.doesNotMatch(forbidden, /data-action/, "a role refusal offers nothing to press");
});

test("Skeleton: one announced region, placeholders hidden from assistive technology", () => {
  const markup = html(createElement(SkeletonGroup, null, createElement(Skeleton, { height: 52 })));
  assert.match(markup, /aria-busy="true" aria-label="Loading" class="c-skeleton-group" role="status"/);
  assert.match(markup, /aria-hidden="true" class="c-skeleton" style="width:100%;height:52px"/);
});

test("Dialog and SidePanel: labelled modal surfaces whose Cancel runs the model's Action", () => {
  const dialog = html(createElement(Dialog, { title: "Delete Rostik?", cancel: action("cancel", "Cancel", noop), actions: createElement(ActionButton, { action: action("confirm", "Delete", noop, { danger: true }), variant: "danger" }) }, "body"));
  assert.match(dialog, /<dialog aria-labelledby="[^"]+" class="c-dialog">/);
  assert.match(dialog, /data-action="cancel"/);
  assert.match(dialog, /data-action="confirm"/);
  assert.ok(dialog.indexOf('data-action="cancel"') < dialog.indexOf('data-action="confirm"'), "Cancel comes before the primary");
  assert.match(dialog, /aria-label="Close"/);
  assert.match(html(createElement(SidePanel, { title: "Game settings", cancel: action("sheet.close", "Cancel", noop) })), /class="c-panel"/);
});

test("Frame: Home is current on the overview and Worlds is not; Access carries the request count", () => {
  const shell = {
    navigation: [{ id: "worlds", label: "Worlds", href: "#/worlds/mc", current: true }, { id: "access", label: "Access", href: "#/access/users", current: false }, { id: "profile", label: "Profile", href: "#/profile", current: false }],
    page: "worlds",
    overview: { id: "worlds", label: "Home", href: "#/home/mc", current: true },
    requests: 2,
  } as unknown as ShellModel;
  const items = frameItems(shell);
  assert.deepEqual(items.map((item) => [item.key, item.current]), [["home", true], ["worlds", false], ["access", false], ["profile", false]]);
  assert.equal(items.find((item) => item.key === "access")?.badge, 2);
  assert.equal(frameItems({ ...shell, overview: { ...shell.overview!, current: false } }).find((item) => item.key === "worlds")?.current, true);
});

test("Shell helpers: a world's tab is not a page; operations and outcomes become flashbar items", () => {
  assert.equal(pageKey("#/worlds/mc/rostik/metrics"), pageKey("#/worlds/mc/rostik"));
  assert.notEqual(pageKey("#/worlds/mc"), pageKey("#/releases/mc"));
  assert.equal(transitionKind("#/worlds/mc", "#/worlds/mc/rostik"), "page", "a world's page from the list is a page switch (A1)");
  assert.equal(transitionKind("#/worlds/mc/rostik", "#/worlds/mc/cinder/metrics"), "pane", "another world beside the list column moves only the pane (A2)");
  assert.equal(transitionKind("#/worlds/mc/rostik", "#/worlds/mc/rostik/metrics"), null, "a tab is not a page (A3 instead)");
  assert.equal(transitionKind("#/access/users", "#/access/roles"), "pane");
  assert.equal(transitionKind("#/home/mc", "#/worlds/mc"), "page");
  const shell = { flash: { operations: [{ id: "op1", label: "Starting session", worldName: "Rostik", worldId: "rostik", startedAt: "2026-11-21T10:00:00Z" }] } } as unknown as ShellModel;
  const items = flashItems(shell, { items: [{ id: 7, message: "Saved", tone: "error" }], dismiss: noop }, null);
  assert.deepEqual(items.map((item) => [item.kind, item.message]), [["busy", "Starting session · Rostik"], ["err", "Saved"]]);
  assert.equal(items[0]!.since, "2026-11-21T10:00:00Z");
  assert.equal(flashItems(shell, { items: [], dismiss: noop }, "rostik")[0]!.since, undefined, "the world's own page shows its elapsed time once, in the hero");
  assert.equal(elapsed("2026-11-21T10:00:00Z", Date.parse("2026-11-21T10:01:05Z")), "1:05");
  assert.equal(relativeTime("2026-11-21T10:00:00Z", Date.parse("2026-11-21T10:08:00Z")), "8 min ago");
});

// --- S2 primitives ---------------------------------------------------------------

type Row = Readonly<{ id: string; name: string; players: number; act: ReturnType<typeof action> }>;
const tableRows: Row[] = [{ id: "a", name: "Rostik", players: 3, act: action("world.invite", "Invite", noop) }, { id: "b", name: "Cinder", players: 0, act: action("world.invite", "Invite", noop) }];

test("Table: labels once in the header, one end-edge action column, records label their cells", () => {
  const markup = html(createElement(Table<Row>, {
    label: "Worlds",
    rows: tableRows,
    rowKey: (row) => row.id,
    selected: (row) => row.id === "a",
    columns: [
      { id: "name", header: "Name", kind: "lead", render: (row) => createElement("a", { href: `#/${row.id}` }, row.name), sort: "ascending", onSort: noop },
      { id: "players", header: "Players", kind: "num", render: (row) => row.players },
      { id: "actions", header: "Actions", kind: "act", render: (row) => createElement(ActionButton, { action: row.act, size: "sm" }) },
    ],
  }));
  assert.match(markup, /<table aria-label="Worlds" class="c-table" data-layout="rows">/);
  assert.equal((markup.match(/<th /g) ?? []).length, 3, "labels once, in the header");
  assert.match(markup, /aria-sort="ascending"/);
  assert.match(markup, /<button class="c-sort"/);
  assert.match(markup, /<span class="c-sr">Actions<\/span>/);
  assert.match(markup, /class="c-col-num" data-label="Players"/);
  assert.doesNotMatch(markup, /c-col-act" data-label/, "the action column carries no record label");
  assert.match(markup, /<tr class="c-row-selected">/);
  assert.equal((markup.match(/data-action="world.invite"/g) ?? []).length, 2);
  const empty = html(createElement(Table<Row>, { label: "Worlds", rows: [], rowKey: (row) => row.id, columns: [{ id: "n", header: "Name", render: (row) => row.name }], empty: createElement(Empty, { icon: "public", title: "No worlds", size: "sm" }) }));
  assert.match(empty, /<tr class="c-table-empty"><td colSpan="1">/i);
  assert.match(html(createElement(Table<Row>, { label: "Worlds", rows: [], loading: true, rowKey: (row) => row.id, columns: [{ id: "n", header: "Name", render: (row) => row.name }] })), /<tbody aria-busy="true"/);
  assert.equal(nextSort("ascending"), "descending");
  assert.equal(nextSort(null), "ascending");
});

test("TrackList: one grid of shared tracks, the header once, rows as table rows", () => {
  const markup = html(createElement(TrackList<Row>, {
    label: "Operations",
    rows: tableRows,
    rowKey: (row) => row.id,
    tracks: [
      { id: "what", header: "Operation", width: "minmax(0, 1fr)", kind: "stack", render: (row) => createElement(TrackTitle, { title: row.name, href: "#/x", line: "op-1", compactLine: "3 min" }) },
      { id: "for", header: "Running for", width: "120px", kind: "optional", render: () => "3 min" },
      { id: "act", header: "Actions", width: "auto", kind: "end", quietHeader: true, render: (row) => createElement(ActionButton, { action: row.act, size: "sm" }) },
    ],
  }));
  assert.match(markup, /role="table"/);
  assert.match(markup, /--c-tracks:minmax\(0, 1fr\) 120px auto;--c-tracks-compact:minmax\(0, 1fr\) auto/);
  assert.equal((markup.match(/role="columnheader"/g) ?? []).length, 3);
  assert.equal((markup.match(/role="row"/g) ?? []).length, 3);
  assert.match(markup, /c-track c-track-optional/);
  assert.match(markup, /<a class="c-track-title" href="#\/x">Rostik<\/a>/);
});

test("ListColumn: a filter field, chips with counts, the current row marked", () => {
  const markup = html(createElement(ListColumn, {
    label: "Worlds of Minecraft",
    filter: { value: "", set: noop, placeholder: "Filter worlds" },
    chips: [{ id: "all", label: "All", count: 2, pressed: true, onPress: noop }],
    groups: [{ id: "g", items: [
      createElement(ListItemWorld, { key: "a", href: "#/a", current: true, name: "Rostik", players: 3, hosting: "Fleet", status: { kind: "ok", label: "Online" }, line: "1.2 · wipe #2" }),
      createElement(ListItemPerson, { key: "p", href: "#/p", current: false, name: "Nikita", meta: "Viewer", account: "@nikita", accountIcon: "send" }),
    ] }],
  }));
  assert.match(markup, /<nav aria-label="Worlds of Minecraft" class="c-lcol">/);
  assert.match(markup, /aria-label="Filter worlds"/);
  assert.match(markup, /aria-pressed="true" class="c-lcol-chip"/);
  assert.match(markup, /aria-current="true" class="c-listitem c-listitem-world"/);
  assert.match(markup, /c-listitem c-listitem-person/);
});

test("DetailList: every value kind, hints after the value, explanations as tooltips, keys left out", () => {
  const markup = html(createElement(DetailList, {
    omit: ["observed"],
    spans: { address: "w2" },
    details: [
      { key: "session", label: "Session", value: { type: "status", status: { kind: "ok", label: "Online" } }, explain: "One at a time" },
      { key: "observed", label: "Last observed", value: { type: "time", at: "2026-11-21T10:00:00Z" } },
      { key: "world-id", label: "World ID", value: { type: "text", text: "rostik", mono: true }, copy: "rostik" },
      { key: "release", label: "Release", value: { type: "release", active: "1.2", desired: "1.3" } },
      { key: "address", label: "Address", value: { type: "address", address: { value: "1.2.3.4:25565", connectivity: "raw", network: "Public address." } } },
      { key: "preset", label: "Preset", value: { type: "preset", name: "Industrial", source: { commit: "abcdef0", short: "abcdef0", href: "https://x" } } },
      { key: "launched", label: "Launched", value: { type: "time", at: null } },
      { key: "players", label: "Players online", value: { type: "number", value: 3 } },
      { key: "wipe", label: "Current wipe", value: { type: "absent", text: "No wipes yet" }, hint: "Changed", hintAttention: true },
    ],
  }));
  assert.match(markup, /<dl class="c-detail c-detail-four">/);
  assert.doesNotMatch(markup, /Last observed/, "a fact shown elsewhere is left out by key");
  assert.match(markup, /aria-label="One at a time"[^>]*data-tip="One at a time"/);
  assert.match(markup, /aria-label="Copy World ID"/);
  assert.match(markup, /data-tip="Desired 1.3"/);
  assert.match(markup, /c-detail-item c-span-w2/);
  assert.match(markup, /@abcdef0/);
  assert.match(markup, /c-detail-hint c-tone-warn/);
  assert.match(markup, /<span class="c-faint">—<\/span>/, "an unknown time is a dash");
});

test("Address, Copy, Person and Indicator: one line, names for every icon", () => {
  const address = html(createElement(Address, { address: { value: "1.2.3.4:25565", connectivity: "zerotier", network: "ZeroTier network." }, copy: true }));
  assert.match(address, /aria-label="ZeroTier network."[^>]*role="img"/);
  assert.doesNotMatch(address, />ZeroTier network\.</, "the network is a tooltip, never a line");
  assert.match(address, /aria-label="Copy address"/);
  assert.match(html(createElement(Copy, { value: "x", what: "world ID" })), /data-tip="Copy"/);
  const person = html(createElement(Person, { name: "Nikita Example", detail: "@nikita", detailIcon: "send" }));
  assert.match(person, /<span aria-hidden="true" class="c-avatar c-avatar-sm">NE<\/span>/);
  assert.match(person, /c-person-detail/);
  assert.match(html(createElement(Indicator, { status: { kind: "ok", label: "Granted" } })), /aria-label="Granted" class="c-indicator c-tone-ok" data-status="ok" data-tip="Granted" role="img"/);
});

test("Segmented and Tabs: one value chosen, tied to its panel", () => {
  const seg = html(createElement(Segmented<"24h" | "7d">, { label: "Range", options: [{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }], value: "7d", onChange: noop }));
  assert.match(seg, /role="radiogroup"/);
  assert.match(seg, /aria-checked="true" class="c-segment" role="radio" tabindex="0" type="button"><span>7 days/);
  const tabs = html(createElement(Tabs<"details" | "wipes">, { label: "World sections", prefix: "w", tabs: [{ id: "details", label: "Details" }, { id: "wipes", label: "Wipes", count: 2 }], value: "wipes", onChange: noop }));
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /aria-controls="w-panel-wipes" aria-selected="true" class="c-tab" id="w-tab-wipes" role="tab" tabindex="0"/);
  assert.match(tabs, /c-tab-count">2/);
  assert.match(html(createElement(TabPanel, { prefix: "w", id: "wipes" }, "x")), /aria-labelledby="w-tab-wipes" class="c-tabpanel" id="w-panel-wipes" role="tabpanel"/);
});

test("Fields: a label tied to its control, an error tied with aria-describedby", () => {
  const markup = html(createElement(Field, { label: "Player limit", error: "A whole number from 1 to 100." }, createElement(TextInput, { value: "500", onChange: noop })));
  const id = markup.match(/<label class="c-field-label" for="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.match(markup, new RegExp(`id="${id}" aria-invalid="true" aria-describedby="${id}-error"`));
  assert.match(markup, new RegExp(`<span class="c-field-error" id="${id}-error">A whole number`));
  assert.match(html(createElement(Field, { label: "Role" }, createElement(Select, { options: [{ value: "viewer", label: "Viewer" }], value: "viewer", onChange: noop }))), /c-select-chevron/);
  const toggle = html(createElement(Toggle, { action: action("game-settings.pvp", "PvP", noop, { disabled: true, hint: "Saving" }), checked: true }));
  assert.match(toggle, /aria-disabled="true" aria-label="PvP" data-action="game-settings.pvp" role="switch" type="checkbox" checked=""/);
  assert.match(toggle, /data-tip="Saving"/);
  assert.match(html(createElement(RadioCards<"fleet" | "configured">, { legend: "Hosting", name: "hosting", options: [{ value: "fleet", label: "Fleet" }, { value: "configured", label: "Persistent", disabled: true, hint: "Stop it first" }], value: "fleet", onChange: noop })), /<fieldset class="c-radios"><legend class="c-field-label">Hosting/);
  assert.match(html(createElement(Checkbox, { checked: "mixed", onChange: noop, label: "Select all", labelHidden: true })), /aria-checked="mixed" aria-label="Select all"/);
});

test("FilterBar: tokens with remove buttons, a combobox, matches only while filtering, Clear from two tokens", () => {
  const props = { label: "Filter worlds", properties: [{ id: "hosting", label: "Hosting", values: [{ value: "Fleet", count: 2 }] }], onChange: noop, matches: 1 };
  const none = html(createElement(FilterBar, { ...props, tokens: [] }));
  assert.match(none, /role="combobox"/);
  assert.doesNotMatch(none, /matches?</);
  const one = html(createElement(FilterBar, { ...props, tokens: [{ property: "hosting", value: "Fleet" }] }));
  assert.match(one, /aria-label="Remove Hosting Fleet"/);
  assert.match(one, />1 match</);
  assert.doesNotMatch(one, /data-action="filter.clear"/);
  assert.match(html(createElement(FilterBar, { ...props, tokens: [{ property: "hosting", value: "Fleet" }, { property: null, value: "pine" }] })), /data-action="filter.clear"/);
  const rows = [{ name: "Hollow Pines", hosting: "Fleet" }, { name: "Rostik", hosting: "Persistent" }];
  assert.deepEqual(applyFilter(rows, [{ property: "hosting", value: "Fleet" }, { property: null, value: "PINE" }], (row, id) => row[id as "hosting"], (row) => row.name).map((row) => row.name), ["Hollow Pines"]);
});

test("Tiles, Pager, preferences, skeleton rows and the stat card", () => {
  const tiles = html(createElement(Tiles, { label: "Worlds by state" }, createElement(Tile, { status: { kind: "ok", label: "Online" }, count: 0, pressed: false, onPress: noop })));
  assert.match(tiles, /aria-pressed="false" class="c-tile" disabled=""/, "a state no world holds cannot be pressed");
  assert.equal(html(createElement(Pager, { page: 1, pages: 1, onPage: noop })), "", "one page draws no pager");
  const pager = html(createElement(Pager, { page: 5, pages: 9, onPage: noop }));
  assert.match(pager, /aria-current="page" aria-label="Page 5"/);
  assert.match(pager, /…/);
  assert.deepEqual(pageOf([1, 2, 3, 4, 5], 9, 2), { rows: [5], page: 3, pages: 3 });
  const prefs = html(createElement(TablePreferences, { pageSize: { value: 25, set: noop } }));
  assert.match(prefs, /aria-haspopup="menu"/);
  assert.match(prefs, /role="menuitemradio"/);
  assert.match(html(createElement(SkeletonRows, { columns: 3, rows: 2 })), /aria-busy="true"/);
  const stat = html(createElement(StatCard, { label: "CPU", value: null }));
  assert.match(stat, /<section aria-label="CPU" class="c-card c-stat">/);
  assert.match(stat, /—/);
});

// --- review pass 1 ---------------------------------------------------------------

test("MenuButton and ActionButton: a trigger says it opens a menu in the static markup; a row button can carry its own name", () => {
  const markup = html(createElement(MenuButton, { id: "worlds.bulk", label: "Actions", groups: [{ actions: [action("session.start", "Start", noop)] }] }));
  assert.match(markup, /aria-controls="[^"]+" aria-expanded="false" aria-haspopup="menu"[^>]*data-action="worlds.bulk"/);
  assert.match(markup, /data-action="session.start"/, "the menu's Actions are in the markup while it is closed");
  assert.match(html(createElement(ActionButton, { action: action("whitelist.remove.Mira", "Remove", noop, { icon: "close" }), iconOnly: true, name: "Remove Mira" })), /aria-label="Remove Mira"/);
  assert.match(html(createElement(LinkButton, { href: "#/worlds/mc", label: "Table view", icon: "table_rows", iconOnly: true })), /aria-label="Table view" class="c-btn c-btn-default c-btn-icon" data-tip="Table view"/);
});

test("RadioCards: a card can choose by a model Action, and the current one reads checked, not refused", () => {
  const markup = html(createElement(RadioCards<"console" | "terminal">, {
    legend: "Look", name: "look", value: "console", onChange: noop,
    options: [
      { value: "console", label: "Cloud console", action: action("look.console", "Cloud console", noop, { disabled: true, hint: "The face the console wears now" }) },
      { value: "terminal", label: "Terminal", action: action("look.terminal", "Terminal", noop) },
    ],
  }));
  assert.match(markup, /checked="" data-action="look.console"|data-action="look.console"[^>]*checked=""/);
  assert.match(markup, /data-action="look.terminal"/);
  assert.doesNotMatch(markup, /c-radio-disabled/, "the current look is not drawn as refused");
  assert.match(markup, /--c-radio-count:2/, "cards share one row in equal columns");
});

test("SplitPage, list items with icons and the compact-only track line", () => {
  const split = html(createElement(SplitPage, { list: "list", selected: true }, "pane"));
  assert.match(split, /<div class="c-split" data-selected="true"><div class="c-split-list">list<\/div><div class="c-split-pane" data-pane="">pane<\/div><\/div>/);
  const item = html(createElement(ListItemIcon, { href: "#/access/roles", current: false, icon: "admin_panel_settings", name: "Roles" }));
  assert.match(item, /c-listitem-icon/);
  assert.doesNotMatch(item, /c-avatar/, "a place is not a person: no initials");
  assert.match(html(createElement(ListItemWorld, { href: "#", current: false, name: "R", players: null, hosting: "", status: { kind: "ok", label: "Online" }, line: "", standalone: true })), /c-listitem-slot c-listitem-standalone/);
  const compact = html(createElement(TrackTitle, { title: "Password", compactLine: "a@example.com" }));
  assert.match(compact, /<span class="c-track-line c-track-compact">a@example.com<\/span>/, "only the narrow layout draws a second line");
});

test("Notice detail as a tooltip, the dialog footer start, a card's meta, an icon indicator and a tick", () => {
  const notice = html(createElement(Notice, { notice: { id: "port", tone: "warning", title: "The game port is public.", description: "Set a password." }, detail: "tooltip" }));
  assert.match(notice, /aria-label="Set a password." class="c-notice-more" data-tip="Set a password."/);
  assert.doesNotMatch(notice, /c-notice-detail/);
  const panel = html(createElement(SidePanel, { title: "Game settings", cancel: action("sheet.close", "Cancel", noop), start: createElement(ActionButton, { action: action("game-settings.defaults", "Restore defaults", noop) }) }));
  assert.ok(panel.indexOf("c-dialog-start") < panel.indexOf('data-action="sheet.close"'), "the start slot comes before Cancel");
  assert.match(html(createElement(Card, { title: "Online now", count: 1, meta: "3 players" }, "x")), /<\/h2><span class="c-card-meta">3 players<\/span>/);
  assert.match(html(createElement(Indicator, { icon: "bolt", label: "Fleet" })), /aria-label="Fleet" class="c-indicator c-indicator-quiet"/);
  assert.match(html(createElement(Tick, { value: 3 })), /<span class="c-tick">3<\/span>/);
  assert.match(html(createElement(Tick, { value: null })), /—/);
});

test("DetailList: a hint is its own faint line, and a detail without a key spans by label", () => {
  const markup = html(createElement(DetailList, {
    spans: { Operation: "full" },
    details: [
      { key: "host", label: "Compute host", value: { type: "status", status: { kind: "ok", label: "Running" } }, hint: "Shared game host · m7i-flex.large in eu-central-1a" },
      { label: "Operation", value: { type: "text", text: "Starting session" } },
    ],
  }));
  assert.match(markup, /<span class="c-detail-value">.*Running.*<\/span><span class="c-detail-hint" data-tip="Shared game host · m7i-flex.large in eu-central-1a" tabindex="0"><span class="c-detail-hint-text">/);
  assert.match(markup, /c-detail-item c-span-full/);
});

test("A8 and A9 reach the counts and the rows: tiles and card counts tick, and a page hands its own arrivals to a table", () => {
  assert.match(html(createElement(Tile, { status: { kind: "ok", label: "Online" }, count: 2, pressed: false, onPress: noop })), /<span class="c-tick c-tile-count">2<\/span>/);
  assert.match(html(createElement(Card, { title: "Online now", count: 1 }, "x")), /<span class="c-count"><span class="c-tick">1<\/span><\/span>/);
  const markup = html(createElement(Table<Row>, { label: "Worlds", rows: tableRows, rowKey: (row) => row.id, arrivals: new Set(["b"]), columns: [{ id: "n", header: "Name", render: (row) => row.name }] }));
  assert.match(markup, /<tr class="c-arrived"><td[^>]*>Cinder/, "the row the page says arrived is marked");
  assert.doesNotMatch(markup, /<tr class="c-arrived"><td[^>]*>Rostik/);
  const list = html(createElement(TrackList<Row>, { label: "Ops", rows: tableRows, rowKey: (row) => row.id, arrivals: new Set(["a"]), tracks: [{ id: "n", header: "Name", width: "1fr", render: (row) => row.name }] }));
  assert.match(list, /class="c-tracklist-row c-arrived" data-from="1024" data-layout="one-line" role="row"><span class="c-track" data-rail="" role="cell">Rostik/);
});
