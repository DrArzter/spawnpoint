import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import type { ShellModel } from "../src/core/models.ts";
import { flashItems, pageKey, transitionKind } from "../src/skins/cloud/Shell.tsx";
import { ActionButton, LinkButton } from "../src/skins/cloud/ui/ActionButton.tsx";
import { relativeTime } from "../src/skins/cloud/ui/Ago.tsx";
import { Card } from "../src/skins/cloud/ui/Card.tsx";
import { Dialog } from "../src/skins/cloud/ui/Dialog.tsx";
import { Empty, LoadError } from "../src/skins/cloud/ui/Empty.tsx";
import { elapsed } from "../src/skins/cloud/ui/Flashbar.tsx";
import { frameItems } from "../src/skins/cloud/ui/Frame.tsx";
import { Grid } from "../src/skins/cloud/ui/Grid.tsx";
import { Notice } from "../src/skins/cloud/ui/Notice.tsx";
import { Overflow } from "../src/skins/cloud/ui/Overflow.tsx";
import { PageHeader } from "../src/skins/cloud/ui/PageHeader.tsx";
import { SidePanel } from "../src/skins/cloud/ui/SidePanel.tsx";
import { SkeletonGroup, Skeleton } from "../src/skins/cloud/ui/Skeleton.tsx";
import { Status } from "../src/skins/cloud/ui/Status.tsx";

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
  assert.match(card, /<section class="c-card"><header class="c-card-head"><h2>Session<span class="c-count">2<\/span><\/h2><div class="c-card-actions">a<\/div>/);
  assert.match(card, /c-card-body c-card-body-flush/);
  assert.match(html(createElement(Card, { label: "Hero" }, "x")), /<section aria-label="Hero" class="c-card">/);
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
  assert.match(empty, /<div class="c-empty">/);
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
