import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorldModel } from "../src/core/models.ts";
import { consoleSkin } from "../src/skins/console/index.ts";
import { partialLine } from "../src/skins/console/tabs/Backups.tsx";
import { formatUptime as uptime } from "../src/lib/format.ts";
import { aGame, aWorld, noop, spy } from "./support/fixtures.ts";

/*
 * The console world page (skin-spec §6.3): the header pill is the one state
 * mark (R3), facts shown in the hero or the top bar are not repeated in the
 * cards, and the World card owns the hosting and game settings verbs.
 */

const count = (markup: string, pattern: RegExp) => markup.match(new RegExp(pattern.source, "g"))?.length ?? 0;

const world = aWorld({
  id: "rostik",
  placement: "fleet",
  connectivity: "raw",
  wipes: [{ id: "wipe-1", number: 1, state: "current", createdAt: "2026-11-01T10:00:00Z", closedAt: null, originRelease: "1.2" }],
  release: { state: "available", generationId: null, activeRelease: "1.2", desiredRelease: "1.3" },
});
const game = aGame({ worlds: [world] });
const address = { value: "203.0.113.7:25565", connectivity: "raw" as const, network: "Public IP" };

const model: WorldModel = {
  game,
  world,
  worldsHref: "#/worlds/minecraft",
  availability: { kind: "ready", label: "Ready" },
  sessionStatus: { kind: "ok", label: "Online" },
  notices: [],
  tabs: [{ id: "details", label: "Details" }, { id: "wipes", label: "Wipes", count: 1 }, { id: "backups", label: "Backups" }],
  tab: "details",
  setTab: noop,
  session: spy("session.stop", "Stop", { danger: true }),
  refresh: spy("refresh", "Refresh"),
  invite: spy("world.invite", "Invite players"),
  more: [spy("world.pack", "Download client pack"), spy("world.settings", "Hosting & connection"), spy("world.game-settings", "Game settings"), spy("world.wipe", "Start a new wipe"), spy("world.purge", "Delete permanently", { danger: true })],
  sessionDetails: [
    { key: "session", label: "Session", value: { type: "status", status: { kind: "ok", label: "Online" } } },
    { key: "host", label: "Compute host", value: { type: "text", text: "fleet-1" } },
    { key: "launched", label: "Launched", value: { type: "time", at: "2026-11-21T08:00:00Z" } },
    { key: "players", label: "Players online", value: { type: "number", value: 3 } },
    { key: "observed", label: "Last observed", value: { type: "time", at: "2026-11-21T10:00:00Z" } },
  ],
  worldDetails: [
    { key: "world-id", label: "World ID", value: { type: "text", text: "rostik", mono: true }, copy: "rostik" },
    { key: "availability", label: "Availability", value: { type: "status", status: { kind: "ready", label: "Ready" } } },
    { key: "release", label: "Release", value: { type: "release", active: "1.2", desired: "1.3" } },
    { key: "address", label: "Address", value: { type: "address", address } },
  ],
  operations: [],
  wipes: [{ wipe: world.wipes[0]!, showBackups: spy("wipe.backups", "Backups") }],
  backups: {
    canRead: true, canRestore: true, filter: null, setFilter: noop, wipes: world.wipes,
    inventory: { status: "ready", value: { entries: [], unverified: 0, truncated: false } },
    wipeNumber: () => 1, restore: () => spy("backup.restore", "Restore"), download: null,
  },
  releases: { rows: [], state: "available", mods: null, changes: null },
  whitelist: null,
  console: null,
  metrics: null,
  siblings: [
    { id: "rostik", name: "Rostik", href: "#/worlds/minecraft/rostik", status: { kind: "ok", label: "Online" }, releaseSummary: "1.2", wipe: 1, players: 3, placement: "fleet", address },
    { id: "cinder", name: "Cinder", href: "#/worlds/minecraft/cinder", status: { kind: "ready", label: "Ready" }, releaseSummary: "1.2", wipe: null, players: null, placement: "configured", address: null },
  ],
  glance: { live: true, players: 3, address, launchedAt: "2026-11-21T08:00:00Z", busy: false },
};

const render = (patch: Partial<WorldModel> = {}) => renderToStaticMarkup(createElement(consoleSkin.World, { model: { ...model, ...patch } }));

test("console world: the header pill is the only state mark and the hero holds the live facts", () => {
  const markup = render();
  assert.equal(count(markup, /c-status-pill/), 1, "one pill: the header's");
  assert.match(markup, /aria-label="Session at a glance"/);
  assert.doesNotMatch(markup, /Last observed/, "the top bar shows the observed time (R3)");
  assert.doesNotMatch(markup, /<dt><span>Players online/, "the hero shows the players");
  assert.doesNotMatch(markup, /<dt><span>Availability/, "Ready says nothing the pill does not");
  assert.equal(count(markup, /203\.0\.113\.7:25565"/), 2, "the address once in the hero, once in the list column");
  assert.doesNotMatch(markup, /→ 1\.3/, "the World card shows the active release only");
  assert.doesNotMatch(markup, /<dt><span>Launched/, "the hero's uptime says it");
});

test("console world: the World card draws hosting and game settings, the overflow the rest; Refresh is the top bar's", () => {
  const markup = render();
  for (const id of ["world.settings", "world.game-settings", "world.pack", "world.wipe", "world.purge", "session.stop", "world.invite"]) {
    assert.equal(count(markup, new RegExp(`data-action="${id.replace(".", "\\.")}"`)), 1, `${id} once`);
  }
  assert.doesNotMatch(markup, /data-action="refresh"/, "one Refresh per page, in the top bar");
  assert.doesNotMatch(markup, /c-btn-primary[^>]*data-action="session\.stop"/, "Stop is never the primary or a red bar");
  assert.match(render({ session: spy("session.start", "Start") }), /c-btn-primary[^>]*data-action="session\.start"/);
});

test("console world: the list column keeps the tab and marks the current world; no live session has no hero", () => {
  const markup = render({ tab: "wipes" });
  assert.match(markup, /class="c-split"[^>]*data-selected="true"/, "the page sits in the shared split, its pane chosen");
  assert.match(markup, /data-pane=""/);
  assert.doesNotMatch(render({ siblings: undefined }), /c-split/, "no list, no split");
  assert.match(markup, /aria-current="true"[^>]*href="#\/worlds\/minecraft\/rostik\/wipes"/);
  assert.match(markup, /href="#\/worlds\/minecraft\/cinder\/wipes"/);
  const stopped = render({ glance: { live: false, players: null, address: null, launchedAt: null, busy: false } });
  assert.doesNotMatch(stopped, /Session at a glance/);
  assert.match(stopped, /No session/);
  assert.doesNotMatch(stopped, /aria-label="Session"/, "the empty state stands in place of the card");
  assert.match(render({ glance: undefined }), /<dt><span>Launched/, "without a hero the Session card keeps the launch");
  assert.match(stopped, /<dt><span>Address/, "without a hero the World card keeps the address");
});

test("console world: the partial backup line and uptime read as the spec says", () => {
  assert.equal(partialLine(0, false), null);
  assert.equal(partialLine(2, true), "2 objects not shown · older backups exist");
  const start = Date.parse("2026-11-21T08:00:00Z");
  assert.equal(uptime("2026-11-21T08:00:00Z", start + 3_723_000), "1:02:03");
  assert.equal(uptime("2026-11-21T08:00:00Z", start + 26 * 3_600_000), "1 d 2 h");
  assert.equal(uptime(null, start), null);
  assert.match(render({ tab: "backups" }), /No backups/);
});
