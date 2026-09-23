import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action, actionsOf, type Action } from "../src/core/actions.ts";
import type { AccessModel, ConfirmationModel, ConsoleModel, CreateWorldModel, InvitationModel, MetricsModel, ProfileModel, ReleasesModel, ShellModel, WorldModel, WorldsModel, WorldSettingsModel } from "../src/core/models.ts";
import type { Game, World } from "../src/model.ts";
import { consoleSkin } from "../src/skins/console/index.ts";
import type { Skin } from "../src/skins/skin.ts";

/*
 * The skin contract. A skin may draw a model however it likes; what it may
 * not do is drop a verb. Every action reachable from a model must reach the
 * markup as an element carrying data-action with the action's id. Each skin
 * is rendered here against the same fixtures, so a face that forgets Stop, or
 * Approve, or Restore fails before anybody opens it.
 */

const noop = () => undefined;

const spy = (id: string, label: string, rest: Partial<Action> = {}): Action => action(id, label, noop, rest);

const world: World = {
  id: "minecraft-rostik-12345678",
  displayName: "Rostik",
  profileId: "industrial",
  preset: { id: "industrial", repository: "https://github.com/DrArzter/presets", commit: "0123456789abcdef", buildStatus: "ready", latestRelease: "1.2" },
  release: { activeRelease: "1.2", desiredRelease: "1.2", state: "ready" },
  wipes: [{ id: "wipe-2", number: 2, state: "current", originRelease: "1.2", createdAt: "2026-08-20T10:00:00Z", closedAt: null }],
  connectionAddress: "172.29.23.24:25565",
  connectivity: "zerotier",
  placement: "configured",
  materialization: "existing",
  sessionControlAvailable: true,
  worldLifecycleAvailable: true,
} as unknown as World;

const game: Game = {
  id: "minecraft",
  code: "MC",
  displayName: "Minecraft",
  lifecycle: null,
  presets: [{ id: "industrial", displayName: "Industrial", repository: "https://github.com/DrArzter/presets", commit: "0123456789abcdef", buildStatus: "ready", latestRelease: "1.2", releases: ["1.1", "1.2"] }],
  worlds: [world],
} as unknown as Game;

const shell: ShellModel = {
  navigation: [{ id: "worlds", label: "Worlds", href: "#/worlds", current: true }, { id: "profile", label: "Profile", href: "#/profile", current: false }],
  page: "worlds",
  scope: { game, games: [game], statusOf: () => ({ kind: "ok", label: "Online" }), open: true, show: spy("scope.show", "Minecraft"), close: spy("scope.close", "Cancel"), select: noop },
  appearance: { preference: "system", theme: "light", accent: "#1a73e8", label: "System theme (light)", setPreference: async () => undefined, setAccent: async () => undefined },
  cycleTheme: spy("appearance.cycle", "Change theme"),
  viewer: { displayName: "DrArzter", inTelegram: true },
  demo: true,
  observedAt: "Sep 23, 2026, 2:01 PM",
  openProfile: spy("shell.profile", "Open my profile"),
};

const worlds: WorldsModel = {
  status: "ready",
  error: "",
  game,
  unavailable: null,
  notices: [{ id: "load", tone: "error", title: "Current state could not be loaded", description: "boom", action: spy("refresh.notice", "Try again") }],
  overview: { fleet: false, state: "running", status: { kind: "ok", label: "Online" }, headline: "Minecraft online", reason: { text: "The host is up for Rostik", detail: "asked running, reports ready", attention: false }, players: 3, observedAt: "2026-09-23T12:01:00Z", host: { name: "Shared game host", status: { kind: "ok", label: "Running" }, instanceType: "m7i-flex.large", zone: "eu-central-1a", launchedAt: "2026-09-14T18:32:00Z" }, fleetHosts: { running: 0, pending: 0 } },
  rows: [{
    world,
    href: "#/worlds/minecraft/minecraft-rostik-12345678",
    status: { kind: "ok", label: "Online" },
    presetName: "Industrial",
    releaseSummary: "Release 1.2",
    wipe: { number: 2, openedAt: "Aug 20, 2026" },
    wipeAbsent: "No wipes yet",
    address: { value: "172.29.23.24:25565", connectivity: "zerotier", network: "ZeroTier network." },
    addressAbsent: "No address",
    actions: [spy("world.details", "View details"), spy("world.invite", "Invite players"), spy("world.pack", "Download client pack"), spy("world.wipe", "Start a new wipe"), spy("world.archive", "Archive")],
  }],
  emptyDescription: "Create the first world.",
  refresh: spy("refresh", "Refresh"),
  createWorld: spy("world.create", "Create world"),
};

const worldPage: WorldModel = {
  game,
  world,
  worldsHref: "#/worlds/minecraft",
  availability: { kind: "ready", label: "Ready" },
  notices: [{ id: "archived", tone: "warning", title: "This world is archived" }],
  tabs: [{ id: "details", label: "Details" }, { id: "wipes", label: "Wipes", count: 1 }, { id: "backups", label: "Backups" }, { id: "releases", label: "Releases" }],
  tab: "details",
  setTab: noop,
  session: spy("session.stop", "Stop", { danger: true, hint: "Save, back up and stop" }),
  refresh: spy("refresh", "Refresh"),
  invite: spy("world.invite", "Invite players"),
  more: [spy("world.pack", "Download client pack"), spy("world.settings", "Hosting & connection"), spy("world.wipe", "Start a new wipe"), spy("world.archive", "Archive")],
  sessionDetails: [{ label: "Session", value: { type: "status", status: { kind: "ok", label: "Online" } }, hint: "The host is up", explain: "One at a time." }, { label: "Last observed", value: { type: "time", at: "2026-09-23T12:01:00Z" } }],
  worldDetails: [{ label: "World ID", value: { type: "text", text: world.id, mono: true }, copy: world.id }, { label: "Release", value: { type: "release", active: "1.2", desired: "1.2" } }, { label: "Address", value: { type: "address", address: { value: "172.29.23.24:25565", connectivity: "zerotier", network: "ZeroTier network." } } }, { label: "Wipe", value: { type: "absent", text: "No wipes yet" } }, { label: "Players", value: { type: "number", value: 3 } }],
  operations: [{ operation: { id: "exec-1", type: "start", status: "running", startedAt: "2026-09-23T11:00:00Z" }, label: "Starting session" }],
  wipes: [{ wipe: world.wipes[0]!, showBackups: spy("wipe.backups", "Backups") }],
  backups: {
    canRead: true,
    canRestore: true,
    filter: null,
    setFilter: noop,
    wipes: world.wipes,
    inventory: { status: "ready", value: { entries: [{ key: "backups/a.tar.zst", archiveName: "rostik-2026-09-23T11-00-00.tar.zst", generationId: "wipe-2", storedAt: "2026-09-23T11:00:00Z", sizeBytes: 1024, checksum: "abcdef0123456789" }], unverified: 1, truncated: true } },
    wipeNumber: () => 2,
    restore: () => spy("backup.restore", "Restore"),
  },
  releases: { rows: [{ name: "1.2", status: "Active", downloadable: true, download: spy("world.pack", "Download") }], state: "ready" },
};

const metrics: MetricsModel = { source: "cloudwatch", setSource: noop, online: true, instanceId: "i-1", range: "24h", ranges: [{ id: "24h", label: "24 hours" }], setRange: noop, metrics: { status: "error", error: "boom", kind: "failed", retry: spy("metrics.retry", "Try again") } };
const rcon: ConsoleModel = { game, session: { kind: "ok", label: "Online" }, online: true, quickCommands: ["list"] };
const releases: ReleasesModel = { game, loading: false, presets: [{ preset: game.presets[0]!, status: { kind: "ok", label: "Ready" }, createWorld: spy("world.create", "Create world") }], pointers: [{ world, href: "#/w", presetName: "Industrial", summary: "Release 1.2" }] };

const access: AccessModel = {
  tab: "users",
  setTab: noop,
  roleCount: 1,
  users: {
    bootstrap: { state: "unclaimed", telegramId: "1780660807" },
    bootstrapDescription: "Sign in with the configured account.",
    candidates: { status: "ready", value: [{ candidate: { platform: "telegram", platformUserId: "42", displayName: "Nikita", username: "nikita", email: null, photoUrl: null, status: "REQUESTED", requestedAt: "2026-09-14T18:10:00Z", lastSeenAt: "2026-09-14T18:10:00Z" }, account: "@nikita", since: "Requested access Sep 14", roleId: "viewer", setRoleId: noop, approve: spy("access.approve", "Approve"), dismiss: spy("access.dismiss", "Dismiss") }] },
    members: [{ member: { id: "m1", name: "DrArzter", roleId: "owner", links: [] }, roleId: "owner", setRoleId: noop, changing: false, linkedAccounts: spy("access.linked", "Linked accounts") }],
    roles: [{ id: "owner", name: "Owner", description: "Everything", permissions: ["a"] }, { id: "viewer", name: "Viewer", description: "Reads", permissions: ["b"] }],
    rolesLoading: false,
    invitations: { emailMode: true, email: "", setEmail: noop, create: spy("invitation.create", "Create invitation"), issued: { url: "https://x/join?token=t", email: "", copy: spy("invitation.copy", "Copy link") }, list: { status: "ready", value: [{ invitation: { id: "i1", status: "PENDING", deliveryEmail: null, delivery: "none", createdAt: "2026-09-14T18:10:00Z", expiresAt: "2026-09-21T18:10:00Z" } as never, revoke: spy("invitation.revoke", "Revoke") }] } },
    managed: { id: "m1", name: "DrArzter", roleId: "owner", links: [] },
    closeManaged: spy("sheet.close", "Close panel"),
  },
  roles: { roles: { status: "ready", value: [{ id: "owner", name: "Owner", description: "Everything", permissions: ["a"] }] }, reading: { id: "owner", name: "Owner", description: "Everything", permissions: ["a"] }, read: () => spy("access.role.read", "1 permission"), closeReading: spy("sheet.close.role", "Close panel") },
  notifications: { state: "error", error: "boom", retry: spy("notifications.retry", "Try again"), saveStatus: "", games: [game], subscriptions: {}, toggle: (id, label) => spy(`notifications.${id}`, label) },
};

const profile: ProfileModel = {
  member: { id: "m1", name: "DrArzter", roleId: "owner", links: [] },
  role: { id: "owner", name: "Owner", description: "Everything", permissions: ["a"] },
  viewer: { displayName: "DrArzter", inTelegram: true, username: "drarzter" },
  appearance: shell.appearance,
  signOut: spy("profile.signout", "Sign out"),
  openInBrowser: spy("profile.browser", "Open in browser"),
  loginAccounts: {
    accounts: { status: "ready", value: [{ provider: "password", subject: "p", displayName: "DrArzter", username: null, email: "a@example.com", photoUrl: null, verified: true }] },
    linkable: ["telegram"],
    connectTelegram: null,
    addPassword: spy("accounts.password.add", "Add email and password"),
    form: { kind: "add", email: "", setEmail: noop, currentPassword: "", setCurrentPassword: noop, password: "", setPassword: noop, confirmation: "", setConfirmation: noop, error: "", busy: false, submit: spy("accounts.password.submit", "Send verification"), cancel: spy("accounts.password.cancel", "Cancel") },
    rowActions: () => [spy("accounts.password.change", "Change password"), spy("accounts.password.reset", "Send reset link")],
  },
};

const confirmation: ConfirmationModel = { title: "Permanently delete Rostik?", description: "Gone.", destructive: true, confirm: spy("confirm", "Delete forever", { danger: true }), cancel: spy("cancel", "Cancel"), releaseChoice: { value: "1.2", options: [{ version: "1.2", latest: true }], set: noop }, typedConfirmation: { expected: world.id, value: "", set: noop } };
const connection = { placement: "fleet" as const, setPlacement: noop, fleetAvailable: true, connectivity: "raw" as const, setConnectivity: noop, dnsAvailable: true };
const createWorld: CreateWorldModel = { game, presets: game.presets, presetId: "industrial", setPresetId: noop, preset: game.presets[0]!, name: "", setName: noop, release: "1.2", setRelease: noop, connection, valid: false, submit: spy("world.create", "Create world"), cancel: spy("sheet.close", "Close panel") };
const worldSettings: WorldSettingsModel = { game, world, stopped: false, connection, valid: true, save: spy("world.settings.save", "Save settings"), cancel: spy("sheet.close", "Cancel") };
const invitation: InvitationModel = {
  game, world, audience: "direct", setAudience: noop, query: "", setQuery: noop,
  recipients: { status: "ready", value: [{ id: "r1", displayName: "Lena", ready: true, delivery: "Accepts direct invitations", selected: true, toggle: noop }] },
  reachable: 1, selectedCount: 1,
  clearSelection: spy("invitation.clear", "Clear selection"),
  history: { status: "error", error: "boom", kind: "failed", retry: spy("invitation.history.retry", "Try again") },
  refreshHistory: spy("invitation.history.refresh", "Refresh"),
  send: spy("invitation.send", "Send invitation", { hint: "1 player selected." }),
  close: spy("sheet.close", "Close panel"),
};

function renderedActionIds(markup: string): Set<string> {
  return new Set([...markup.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]!));
}

function checkSurface(name: string, markup: string, model: unknown, allowMissing: readonly string[] = []) {
  const rendered = renderedActionIds(markup);
  const missing = actionsOf(model).map((item) => item.id).filter((id) => !rendered.has(id) && !allowMissing.includes(id));
  assert.deepEqual([...new Set(missing)], [], `${name}: actions in the model that never reached the screen`);
}

const skins: readonly Skin[] = [consoleSkin];

for (const skin of skins) {
  test(`${skin.name}: the shell and the scope dialog draw the scope, the theme toggle and the profile door`, () => {
    // The scope model is shared: the shell draws the chip that opens it, the
    // dialog draws the list and the way out.
    const frame = renderToStaticMarkup(createElement(skin.Shell, { model: shell }, "page"));
    const dialog = renderToStaticMarkup(createElement(skin.ScopeDialog, { model: shell.scope }));
    checkSurface("Shell", frame + dialog, shell);
  });

  test(`${skin.name}: the worlds list draws every row verb, refresh and create`, () => {
    checkSurface("Worlds", renderToStaticMarkup(createElement(skin.Worlds, { model: worlds })), worlds);
  });

  test(`${skin.name}: the world page draws stop, invite, the overflow and each tab's verbs`, () => {
    // The tabs draw one at a time; each is rendered at its own tab.
    const details = renderToStaticMarkup(createElement(skin.World, { model: worldPage }));
    const wipes = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "wipes" } }));
    const backups = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "backups" } }));
    const releasesTab = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "releases" } }));
    checkSurface("World", details + wipes + backups + releasesTab, { ...worldPage, backups: { ...worldPage.backups, restore: worldPage.backups.restore(worldPage.backups.inventory.status === "ready" ? worldPage.backups.inventory.value.entries[0]! : (null as never)) } });
  });

  test(`${skin.name}: metrics, console and releases draw their verbs`, () => {
    checkSurface("Metrics", renderToStaticMarkup(createElement(skin.Metrics, { model: metrics })), metrics);
    checkSurface("Console", renderToStaticMarkup(createElement(skin.Console, { model: rcon })), rcon);
    checkSurface("Releases", renderToStaticMarkup(createElement(skin.Releases, { model: releases })), releases);
  });

  test(`${skin.name}: access draws approve, dismiss, roles, invitations and subscriptions on their tabs`, () => {
    const users = renderToStaticMarkup(createElement(skin.Access, { model: access }));
    const roles = renderToStaticMarkup(createElement(skin.Access, { model: { ...access, tab: "roles" } }));
    const notifications = renderToStaticMarkup(createElement(skin.Access, { model: { ...access, tab: "notifications" } }));
    const toggles = { started: access.notifications.toggle("minecraft.started", "Minecraft started"), stopped: access.notifications.toggle("minecraft.stopped", "Minecraft stopped"), broadcast: access.notifications.toggle("invitation.broadcast", "Everyone"), direct: access.notifications.toggle("invitation.direct", "Me") };
    const role = access.roles.roles.status === "ready" ? access.roles.roles.value[0]! : (null as never);
    checkSurface("Access", users + roles + notifications, { ...access, toggles, read: access.roles.read(role) });
  });

  test(`${skin.name}: the profile draws sign out, the browser door and every sign-in method verb`, () => {
    const account = profile.loginAccounts.accounts.status === "ready" ? profile.loginAccounts.accounts.value[0]! : (null as never);
    checkSurface("Profile", renderToStaticMarkup(createElement(skin.Profile, { model: profile })), { ...profile, rowActions: profile.loginAccounts.rowActions(account) });
  });

  test(`${skin.name}: dialogs and sheets draw confirm, cancel, submit, save, send and close`, () => {
    checkSurface("Confirmation", renderToStaticMarkup(createElement(skin.ConfirmationDialog, { model: confirmation })), confirmation);
    checkSurface("CreateWorld", renderToStaticMarkup(createElement(skin.CreateWorldSheet, { model: createWorld })), createWorld);
    checkSurface("WorldSettings", renderToStaticMarkup(createElement(skin.WorldSettingsSheet, { model: worldSettings })), worldSettings);
    checkSurface("Invitation", renderToStaticMarkup(createElement(skin.InvitationSheet, { model: invitation })), invitation);
  });
}

test("the action collector finds actions wherever a model keeps them", () => {
  const nested = { a: spy("one", "One"), list: [{ deep: spy("two", "Two") }], fn: () => spy("three", "Three") };
  assert.deepEqual(actionsOf(nested).map((item) => item.id), ["one", "two"], "functions are not walked: an action a skin must call for is asked for in the test");
});
