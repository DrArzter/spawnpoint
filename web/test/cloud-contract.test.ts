import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action, type Action } from "../src/core/actions.ts";
import type { ShellModel, WorldsModel } from "../src/core/models.ts";
import type { Game, World } from "../src/model.ts";
import { cloudSkin } from "../src/skins/cloud/index.ts";
import { Palette } from "../src/skins/cloud/ui/Palette.tsx";

/*
 * The cloud skin's own contract (skin-spec §7). The shared contract cannot
 * see Actions a model hands out through functions (M6, M7), because the
 * console and terminal faces never ask for them. Here each function is
 * called, and every Action it returns must reach the cloud markup with its
 * data-action. Page slices (S3–S7) add their pages here.
 */

const noop = () => undefined;
const spy = (id: string, label: string, rest: Partial<Action> = {}): Action => action(id, label, noop, rest);
const ids = (markup: string) => new Set([...markup.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]!));

function drawn(name: string, markup: string, actions: readonly Action[]) {
  const rendered = ids(markup);
  assert.deepEqual(actions.map((item) => item.id).filter((id) => !rendered.has(id)), [], `${name}: returned by the model but never drawn`);
}

const world = { id: "rostik", displayName: "Rostik", placement: "fleet", connectivity: "raw", materialization: "existing", wipes: [], release: { activeRelease: "1.2", desiredRelease: "1.2", state: "ready" }, preset: null } as unknown as World;
const game = { id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [], worlds: [world] } as unknown as Game;

const session = spy("session.start", "Start", { icon: "play_arrow" });
const refused = spy("session.stop", "Stop", { disabled: true, hint: "Players are online." });
const invite = spy("world.invite", "Invite players");
const approve = spy("access.approve", "Approve");
const dismiss = spy("access.dismiss", "Dismiss");
const refresh = spy("refresh", "Refresh", { icon: "refresh" });

const shell: ShellModel = {
  navigation: [{ id: "worlds", label: "Worlds", href: "#/worlds/minecraft", current: true }, { id: "access", label: "Access", href: "#/access/users", current: false }],
  page: "worlds",
  scope: { game, games: [game], statusOf: () => ({ kind: "ok", label: "Online" }), open: false, show: spy("scope.show", "Minecraft"), close: spy("scope.close", "Cancel"), select: noop },
  viewer: { displayName: "DrArzter", inTelegram: false },
  demo: true,
  observedAt: "Nov 21, 2026, 10:00 AM",
  openProfile: spy("shell.profile", "Open my profile"),
  overview: { id: "worlds", label: "Home", href: "#/home/minecraft", current: true },
  observedAtIso: "2026-11-21T10:00:00.000Z",
  worlds: [{ id: "rostik", name: "Rostik", href: "#/worlds/minecraft/rostik", status: { kind: "off", label: "Stopped" } }],
  requests: 1,
  refreshAction: () => refresh,
  worldActions: (id) => id === "rostik" ? { session: refused, invite } : null,
  flash: { operations: [] },
};

const worlds: WorldsModel = {
  status: "ready",
  error: "",
  game,
  unavailable: null,
  notices: [],
  overview: { fleet: true, state: "stopped", status: { kind: "off", label: "Stopped" }, headline: "Minecraft stopped", reason: { text: "", detail: "", attention: false }, players: null, observedAt: undefined, host: null, fleetHosts: { running: 0, pending: 0 } },
  rows: [{ world, href: "#/worlds/minecraft/rostik", status: { kind: "off", label: "Stopped" }, presetName: "Industrial", releaseSummary: "Release 1.2", wipe: null, wipeAbsent: "No wipes yet", address: null, addressAbsent: "No address", actions: [spy("world.details", "View details")], players: null, launchedAt: null, sessionAction: () => session }],
  emptyDescription: null,
  refresh: spy("refresh", "Refresh"),
  createWorld: spy("world.create", "Create world"),
  view: "overview",
  views: { overview: "#/home/minecraft", list: "#/worlds/minecraft" },
  operations: [],
  builds: [],
  requests: { status: "ready", value: [{ id: "telegram:42", displayName: "Nikita", platform: "telegram", account: "@nikita", since: "2026-11-21T09:00:00.000Z", photoUrl: null }] },
  requestActions: (id) => id === "telegram:42" ? { approve, dismiss } : null,
};

test("cloud: the top bar draws the refresh the shell asks for, and the request count", () => {
  const markup = renderToStaticMarkup(createElement(cloudSkin.Shell, { model: shell }, "page"));
  drawn("Top bar", markup, [shell.refreshAction!()]);
  assert.match(markup, /aria-label="1 requests"/);
  assert.doesNotMatch(markup, /theme/i, "no theme control in the frame (R7)");
});

test("cloud: the game home draws each world's start and each request's approve and dismiss", () => {
  const markup = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: worlds }));
  const verbs = worlds.requestActions!("telegram:42")!;
  drawn("Home", markup, [worlds.rows[0]!.sessionAction!(), verbs.approve, verbs.dismiss]);
  drawn("Worlds list", renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, view: "list" } })), [worlds.rows[0]!.sessionAction!()]);
});

test("cloud: the worlds list filters by a pressed tile, never by a second status mark, and says why bulk Actions wait", () => {
  const markup = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, view: "list" } }));
  assert.match(markup, /aria-label="Filter by status"/);
  assert.match(markup, /<button aria-pressed="false" class="c-tile"/);
  assert.doesNotMatch(markup, /c-filter-token-key">Status/);
  const bulk = markup.match(/<button[^>]*data-action="worlds.bulk"[^>]*>/)?.[0] ?? "";
  assert.match(bulk, /aria-disabled="true"/);
  assert.match(bulk, /aria-haspopup="menu"/);
  assert.match(bulk, /aria-expanded="false"/);
  assert.match(markup, /Select worlds first/);
  assert.match(markup, /data-action="refresh"/);
});

test("cloud: the game home leaves out the requests card without the role, and offers one Create when there are no worlds", () => {
  const plain = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, requests: null } }));
  assert.doesNotMatch(plain, /Access requests/);
  const empty = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, rows: [] } }));
  assert.equal(empty.match(/data-action="world.create"/g)?.length, 1);
});

test("cloud: the worlds-by-state bar fills each state kind on its own, so online and ready never merge", () => {
  const online = { ...worlds.rows[0]!, world: { ...world, id: "a" }, status: { kind: "ok", label: "Online" } } as const;
  const ready = { ...worlds.rows[0]!, world: { ...world, id: "b" }, status: { kind: "ready", label: "Ready" } } as const;
  const markup = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, rows: [online, ready] } }));
  assert.match(markup, /class="c-bystate-seg c-bystate-ok"/);
  assert.match(markup, /class="c-bystate-seg c-bystate-ready"/);
});

test("cloud: a state handed over by the game home belongs to that history entry only", () => {
  // The test window keeps no history entries; stand one in.
  const entry = window.history as unknown as { state: unknown };
  entry.state = { cloudWorldsState: "Stopped" };
  try {
    const markup = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, view: "list" } }));
    assert.match(markup, /<button aria-pressed="true" class="c-tile"/);
  } finally {
    entry.state = null;
  }
  const later = renderToStaticMarkup(createElement(cloudSkin.Worlds, { model: { ...worlds, view: "list" } }));
  assert.doesNotMatch(later, /aria-pressed="true" class="c-tile"/);
});

test("cloud: the palette, once open, draws each world's verbs and says why one is refused", () => {
  const markup = renderToStaticMarkup(createElement(Palette, { model: shell, onClose: noop }));
  const verbs = shell.worldActions!("rostik")!;
  drawn("Palette", markup, [verbs.session, verbs.invite!, shell.refreshAction!()]);
  assert.match(markup, /aria-disabled="true"[^>]*data-action="session.stop"/);
  assert.match(markup, /Players are online\./);
  assert.match(markup, /role="combobox"/);
});
