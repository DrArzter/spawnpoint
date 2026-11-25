import { connectionOptions } from "../src/core/forms.ts";
import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { actionsOf } from "../src/core/actions.ts";
import { roleChoice } from "../src/core/roles.ts";
import type { AccessModel, AssistantChatModel, AssistantPanelModel, WorldLogModel, ConfigEditorModel, ConfigFilesModel, ConfirmationModel, ConsoleModel, CreateWorldModel, GameSettingsModel, InvitationModel, MetricsModel, ModsModel, ProfileModel, ReleasesModel, WhitelistModel, WorldModel, WorldSettingsModel } from "../src/core/models.ts";
import { SKINS } from "../src/skins/index.ts";
import { aGame, aMember, aPermission, aPreset, aRole, aRolesModel, aShell, aWorld, aWorlds, noop, spy } from "./support/fixtures.ts";

/*
 * The skin contract. A skin may draw a model however it likes; what it may
 * not do is drop a verb. Every action reachable from a model must reach the
 * markup as an element carrying data-action with the action's id. Each skin
 * is rendered here against the same fixtures, so a face that forgets Stop, or
 * Approve, or Restore fails before anybody opens it.
 */

const world = aWorld({
  preset: { id: "industrial", repository: "https://github.com/DrArzter/presets", commit: "0123456789abcdef", profileDigest: "sha256:0", buildStatus: "ready", latestRelease: "1.2", releases: ["1.1", "1.2"] },
  wipes: [{ id: "wipe-2", number: 2, state: "current", originRelease: "1.2", createdAt: "2026-08-20T10:00:00Z", closedAt: null }],
  connectionAddress: "172.29.23.24:25565",
});

const game = aGame({ presets: [aPreset()], worlds: [world] });

const shell = aShell(game, {
  navigation: [{ id: "worlds", label: "Worlds", href: "#/worlds", current: true }, { id: "profile", label: "Profile", href: "#/profile", current: false }],
  scope: { game, games: [game], statusOf: () => ({ kind: "ok", label: "Online" }), open: true, show: spy("scope.show", "Minecraft"), close: spy("scope.close", "Cancel"), select: noop },
  appearance: { preference: "system", theme: "light", accent: "#1a73e8", label: "System theme (light)", setPreference: async () => undefined, setAccent: async () => undefined },
  viewer: { displayName: "DrArzter", inTelegram: true },
  observedAt: "Sep 23, 2026, 2:01 PM",
});

const worlds = aWorlds(game, {
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
});

const modRows = [
  { file: "create-1.20.1-0.5.1.j.jar", bytes: 14_221_830, sha256: "c".repeat(64), source: "curseforge" as const, download: spy("mod.download.ccc", "Download") },
  { file: "jei-1.20.1-forge-15.20.0.106.jar", bytes: 1_402_115, sha256: "d".repeat(64), source: null, download: spy("mod.download.ddd", "Download") },
];
const modSources = [{ source: "curseforge" as const, label: "CurseForge", count: 1 }, { source: "unknown" as const, label: "Unknown", count: 1 }];

// One page of a release's mods; each change names the call a person's choice would make.
function modsModel(over: Partial<ModsModel> = {}): ModsModel {
  return {
    release: "1.2", split: true, search: "", setSearch: noop, source: null, setSource: noop, sources: modSources,
    sort: { key: "name", direction: "ascending" }, setSort: noop, page: 1, pages: 1, setPage: noop, narrowed: false, clear: noop,
    files: { status: "ready", value: { rows: modRows, total: 2, all: 2 } },
    ...over,
  };
}

const worldPage: WorldModel = {
  game,
  world,
  worldsHref: "#/worlds/minecraft",
  availability: { kind: "ready", label: "Ready" },
  sessionStatus: { kind: "ok", label: "Online" },
  notices: [{ id: "archived", tone: "warning", title: "This world is archived" }],
  tabs: [{ id: "details", label: "Details" }, { id: "wipes", label: "Wipes", count: 1 }, { id: "backups", label: "Backups" }, { id: "releases", label: "Releases" }, { id: "config", label: "Config" }, { id: "console", label: "Console" }, { id: "metrics", label: "Metrics" }],
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
    download: () => spy("backup.download", "Download archive"),
  },
  releases: {
    rows: [{ name: "1.2", status: "Active", downloadable: true, sourceHref: "https://github.com/example/preset", downloads: [spy("world.pack", "Client"), spy("release.pack.server", "Server"), spy("release.pack.full", "Full")] }],
    state: "ready",
    mods: modsModel(),
    changes: { release: "1.2", changes: { status: "ready", value: { from: "1.1", unchanged: 40, rows: [
      { id: "removed:Server mod:oldmod-1.jar", change: "removed", part: "Server mod", name: "oldmod-1.jar", detail: "oldmod" },
      { id: "changed:Server mod:create-0.6.jar", change: "changed", part: "Server mod", name: "create-0.6.jar", detail: "was create-0.5.jar" },
      { id: "added:Override:config/new.toml", change: "added", part: "Override", name: "config/new.toml", detail: null },
    ] } } },
  },
  // Drawn on their own tabs below; on the details tab none is on screen.
  whitelist: null,
  config: null,
  log: null,
  console: null,
  metrics: null,
};

const metrics: MetricsModel = { range: "24h", ranges: [{ id: "24h", label: "24 hours" }], setRange: noop, metrics: { status: "error", error: "boom", kind: "failed", retry: spy("metrics.retry", "Try again") } };
const metricsWithoutHost: MetricsModel = { ...metrics, metrics: { status: "ready", value: null } };
const rcon: ConsoleModel = {
  game,
  world,
  session: { kind: "ok", label: "Online" },
  online: true,
  log: { status: "ready", value: [
    { id: "c1", at: "2026-10-09T18:40:03.000Z", who: "Alex", command: "list", status: { kind: "ok", label: "Answered" }, output: "There are 3 of a max of 20 players online: Alex, Mira, Kira", pending: false },
    { id: "c2", at: "2026-10-09T18:41:12.000Z", who: "DrArzter", command: "say hello", status: { kind: "progress", label: "Waiting for the game" }, output: null, pending: true },
  ] },
  draft: "time set day",
  setDraft: noop,
  run: spy("console.run", "Run"),
  quickCommands: [spy("console.quick", "list"), spy("console.quick", "save-all")],
  unavailable: null,
};
const rconUnreadable: ConsoleModel = { ...rcon, log: { status: "error", error: "boom", kind: "failed", retry: spy("console.retry", "Try again") } };
const releases: ReleasesModel = { game, loading: false, presets: [{ preset: game.presets[0]!, status: { kind: "ok", label: "Ready" }, createWorld: spy("world.create", "Create world"), build: spy("release.build", "Build new release") }], pointers: [{ world, href: "#/w", presetName: "Industrial", summary: "Release 1.2" }] };

const accessRoles = [aRole({ id: "role-a", name: "Role A", protected: true }), aRole({ id: "role-b", name: "Role B", permissions: ["perm.two"], builtIn: false })];

const access: AccessModel = {
  tab: "users",
  setTab: noop,
  roleCount: 2,
  catalogue: [aPermission(), aPermission({ id: "perm.two", group: "Group Two", label: "Do two", description: "Does the second thing." })],
  users: {
    bootstrap: { state: "unclaimed", telegramId: "1780660807" },
    bootstrapDescription: "Sign in with the configured account.",
    candidates: { status: "ready", value: [{ id: "telegram:42", candidate: { platform: "telegram", platformUserId: "42", displayName: "Nikita", username: "nikita", email: null, photoUrl: null, status: "REQUESTED", requestedAt: "2026-09-14T18:10:00Z", lastSeenAt: "2026-09-14T18:10:00Z" }, account: "@nikita", since: "Requested access Sep 14", role: roleChoice(accessRoles, "role-b", false), setRoleId: noop, approve: spy("access.approve", "Approve"), dismiss: spy("access.dismiss", "Dismiss") }] },
    members: [
      { member: aMember({ id: "m1", name: "DrArzter", roleId: "role-a", canDelete: false }), role: roleChoice(accessRoles, "role-a", false), setRoleId: noop, changing: false, linkedAccounts: spy("access.linked", "Linked accounts"), remove: null },
      { member: aMember({ id: "m2", name: "Mira", roleId: "role-b" }), role: roleChoice(accessRoles, "role-b", false), setRoleId: noop, changing: false, linkedAccounts: spy("access.linked", "Linked accounts"), remove: spy("access.delete", "Delete user", { danger: true, icon: "delete_forever" }) },
    ],
    roles: accessRoles,
    invitations: { emailMode: true, email: "", setEmail: noop, create: spy("invitation.create", "Create invitation"), issued: { url: "https://x/join?token=t", email: "", copy: spy("invitation.copy", "Copy link") }, list: { status: "ready", value: [{ invitation: { id: "i1", status: "PENDING", deliveryEmail: null, delivery: "none", createdAt: "2026-09-14T18:10:00Z", expiresAt: "2026-09-21T18:10:00Z" } as never, revoke: spy("invitation.revoke", "Revoke") }] } },
    managed: aMember({ id: "m1", name: "DrArzter", roleId: "role-a", canDelete: false }),
    closeManaged: spy("sheet.close", "Close panel"),
    deletion: { title: "Delete Mira?", description: "Removes their sign-in methods, sessions and agent connections. This cannot be undone.", destructive: true, confirm: spy("access.delete.confirm", "Delete user", { danger: true, disabled: true }), cancel: spy("access.delete.cancel", "Cancel"), releaseChoice: null, typedConfirmation: { label: "User name", expected: "Mira", value: "", set: noop } },
  },
  roles: aRolesModel(accessRoles, { reading: accessRoles[0]! }),
  notifications: { state: "error", error: "boom", retry: spy("notifications.retry", "Try again"), saveStatus: "", games: [game], subscriptions: {}, toggle: (id, label) => spy(`notifications.${id}`, label) },
};

const profile: ProfileModel = {
  member: aMember({ id: "m1", name: "DrArzter", roleId: "role-a" }),
  role: aRole({ id: "role-a", name: "Role A" }),
  viewer: { displayName: "DrArzter", inTelegram: true, username: "drarzter", photoUrl: "https://example.test/me.webp" },
  avatar: { change: spy("profile.avatar.change", "Change picture"), remove: spy("profile.avatar.remove", "Remove picture") },
  appearance: shell.appearance,
  look: { current: "console", options: [{ id: "console", name: "Cloud console", choose: spy("look.console", "Cloud console", { disabled: true }) }, { id: "terminal", name: "Terminal", choose: spy("look.terminal", "Terminal") }] },
  language: { current: "en", options: [{ id: "en", name: "English", choose: spy("language.en", "English", { disabled: true }) }, { id: "ru", name: "Русский", choose: spy("language.ru", "Русский") }] },
  signOut: spy("profile.signout", "Sign out"),
  openInBrowser: spy("profile.browser", "Open in browser"),
  loginAccounts: {
    accounts: { status: "ready", value: [{ provider: "password", subject: "p", displayName: "DrArzter", username: null, email: "a@example.com", photoUrl: null, verified: true }] },
    linkable: ["telegram"],
    connectTelegram: null,
    connectGoogle: null,
    addPassword: spy("accounts.password.add", "Add email and password"),
    form: { kind: "add", email: "", setEmail: noop, currentPassword: "", setCurrentPassword: noop, password: "", setPassword: noop, confirmation: "", setConfirmation: noop, error: "", busy: false, submit: spy("accounts.password.submit", "Send verification"), cancel: spy("accounts.password.cancel", "Cancel") },
    rowActions: () => [spy("accounts.password.change", "Change password"), spy("accounts.password.reset", "Send reset link")],
  },
};

const confirmation: ConfirmationModel = { title: "Permanently delete Rostik?", description: "Gone.", destructive: true, confirm: spy("confirm", "Delete forever", { danger: true }), cancel: spy("cancel", "Cancel"), releaseChoice: { label: "Release for the new wipe", value: "1.2", options: [{ version: "1.2", latest: true }], set: noop }, typedConfirmation: { label: "World ID", expected: world.id, value: "", set: noop } };
const connection = { placement: "fleet" as const, setPlacement: noop, fleetAvailable: true, connectivity: "raw" as const, setConnectivity: noop, dnsAvailable: true, connections: connectionOptions("fleet", true) };
const createWorld: CreateWorldModel = { game, presets: game.presets, presetId: "industrial", setPresetId: noop, preset: game.presets[0]!, name: "", setName: noop, release: "1.2", setRelease: noop, connection, valid: false, submit: spy("world.create", "Create world"), cancel: spy("sheet.close", "Close panel") };
const worldSettings: WorldSettingsModel = { game, world, stopped: false, connection, valid: true, save: spy("world.settings.save", "Save settings"), cancel: spy("sheet.close", "Cancel") };
const whitelist: WhitelistModel = {
  world,
  list: { status: "ready", value: { managed: true, updatedAt: "2026-10-09T11:00:00Z", updatedBy: "DrArzter", rows: [
    { name: "DrArzter", remove: spy("whitelist.remove.DrArzter", "Remove", { danger: true }) },
    { name: "Mira", remove: spy("whitelist.remove.Mira", "Remove", { danger: true }) },
  ] } },
  draft: "a",
  setDraft: noop,
  draftError: "3 to 16 letters, digits or underscores, as the player types it.",
  add: spy("whitelist.add", "Add player", { disabled: true }),
};
const configFiles: ConfigFilesModel = {
  world,
  editor: null,
  list: { status: "ready", value: { release: "1.3", rows: [
    { path: "config/claims.toml", bytes: 41, edited: true, added: false, releaseChanged: true, updatedAt: "2026-11-20T19:05:00Z", updatedBy: "DrArzter", open: spy("config.open.config/claims.toml", "Edit") },
    { path: "config/large.bin", bytes: 6_291_456, edited: false, added: false, releaseChanged: false, updatedAt: null, updatedBy: null, open: spy("config.open.config/large.bin", "Edit", { disabled: true, hint: "6.0 MiB: not text, or too large to edit here" }) },
  ] } },
};
const configEditor: ConfigEditorModel = {
  path: "config/claims.toml",
  content: { status: "ready", value: null },
  text: "[claims]\nmax_chunks = 200\n",
  setText: noop,
  dirty: true,
  save: spy("config.save", "Save"),
  reset: spy("config.reset", "Reset to release"),
  reload: spy("config.reload", "Reload"),
  close: spy("config.close", "Close"),
};
const assistantPanel: AssistantPanelModel = {
  choices: [{ value: "haiku", label: "Haiku", hint: "Fast and cheap" }, { value: "sonnet", label: "Sonnet", hint: "Slower and dearer" }],
  model: "haiku",
  setModel: noop,
  question: "Why the lag?",
  setQuestion: noop,
  ask: spy("assistant.ask", "Explain"),
  answer: { status: "ready", value: { text: "A Create crafter at 120 64 -88 throws every tick.\n\n- Remove it.", at: "2026-11-24T12:00:00Z" } },
};
const worldLog: WorldLogModel = {
  world,
  read: spy("log.read", "Read log"),
  log: { status: "ready", value: { at: "2026-11-24T11:59:00Z", rows: [
    { id: "r:0", at: null, text: "[18:41:03] player-1 joined the game", tone: "plain" },
    { id: "r:1", at: null, text: "[18:43:17] [Server thread/WARN]: Can't keep up!", tone: "warning" },
    { id: "r:2", at: null, text: "[18:44:40] [Server thread/ERROR]: Exception ticking block entity", tone: "error" },
  ] } },
  assistant: assistantPanel,
};
const gameSettings: GameSettingsModel = {
  game, world, running: true,
  fields: [
    { id: "difficulty", label: "Difficulty", kind: "choice", value: "hard", options: [{ value: "normal", label: "Normal" }, { value: "hard", label: "Hard" }], set: noop },
    { id: "max_players", label: "Player limit", kind: "number", value: "500", min: 1, max: 100, set: noop, error: "A whole number from 1 to 100." },
    { id: "motd", label: "Server list message", hint: "Letters, digits and spaces", kind: "text", value: "Rostik", maxLength: 59, set: noop, error: null },
    { id: "allow_flight", label: "Allow flight", hint: "For jetpacks", kind: "toggle", checked: true, toggle: spy("game-settings.allow_flight", "Allow flight") },
  ],
  save: spy("game-settings.save", "Save settings", { disabled: true, hint: "Correct the marked settings first." }),
  restoreDefaults: spy("game-settings.defaults", "Restore defaults"),
  cancel: spy("sheet.close", "Cancel"),
};
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

const assistantChat: AssistantChatModel = {
  open: spy("assistant.show", "Assistant"),
  shown: true,
  close: spy("assistant.close", "Close"),
  conversations: { status: "ready", value: [
    { id: "c1", title: "Start Creative", status: { kind: "pending", label: "Waiting for you" }, updatedAt: "2026-11-24T12:00:00Z", current: true, select: spy("assistant.open.c1", "Start Creative") },
    { id: "c2", title: "Why the lag?", status: { kind: "ok", label: "Done" }, updatedAt: "2026-11-23T12:00:00Z", current: false, select: spy("assistant.open.c2", "Why the lag?") },
  ] },
  thread: {
    title: "Start Creative", status: { kind: "pending", label: "Waiting for you" }, note: null, working: false,
    entries: { status: "ready", value: [
      { kind: "owner", id: "e0", text: "Start Creative please" },
      { kind: "read", id: "e1", title: "Get Spawnpoint control plane", status: { kind: "ok", label: "Read" } },
      { kind: "assistant", id: "e2", text: "Creative is stopped. I propose to start it." },
      { kind: "proposal", id: "e3", title: "Start world", destructive: false, detail: '{\n  "worldId": "creative"\n}', status: { kind: "pending", label: "Waiting for you" }, result: null, apply: spy("assistant.apply.p1", "Apply"), reject: spy("assistant.reject.p1", "Reject") },
      { kind: "proposal", id: "e4", title: "Wipe world", destructive: true, detail: "{}", status: { kind: "ok", label: "Applied" }, result: '{"result":"requested"}', apply: null, reject: null },
    ] },
  },
  startNew: spy("assistant.new", "New conversation"),
  choices: [{ value: "haiku", label: "Haiku", hint: "Fast and cheap" }, { value: "sonnet", label: "Sonnet", hint: "Slower and dearer" }],
  model: "haiku",
  setModel: noop,
  draft: "",
  setDraft: noop,
  send: spy("assistant.send", "Send", { disabled: true, hint: "The assistant is working, or waits for your decision" }),
};

// Every registered face, so a skin added to the registry joins the contract
// without anyone remembering to list it here.
for (const skin of SKINS) {
  test(`${skin.name}: the shell and the scope dialog draw the scope and the profile door`, () => {
    // The scope model is shared: the shell draws the chip that opens it, the
    // dialog draws the list and the way out.
    const frame = renderToStaticMarkup(createElement(skin.Shell, { model: shell }, "page"));
    const dialog = renderToStaticMarkup(createElement(skin.ScopeDialog, { model: shell.scope }));
    checkSurface("Shell", frame + dialog, shell);
  });

  test(`${skin.name}: the Owner's assistant opens from the frame over any page, with its conversations, proposals and message box (ADR-0096)`, () => {
    const closed = renderToStaticMarkup(createElement(skin.Shell, { model: { ...shell, assistant: { ...assistantChat, shown: false } } }, "page"));
    assert.match(closed, /data-action="assistant\.show"/);
    assert.doesNotMatch(closed, /data-action="assistant\.send"/, "the panel is closed");
    assert.doesNotMatch(renderToStaticMarkup(createElement(skin.Shell, { model: shell }, "page")), /data-action="assistant\./, "no assistant for anyone else");
    const open = renderToStaticMarkup(createElement(skin.Shell, { model: { ...shell, assistant: assistantChat } }, "page"));
    checkSurface("Assistant", open, assistantChat);
    for (const text of ["Start Creative please", "I propose to start it", "Get Spawnpoint control plane", "Start world", "Wipe world", "Haiku", "Sonnet", "Fast and cheap", "Why the lag?", "&quot;result&quot;:&quot;requested&quot;"]) assert.ok(open.includes(text), text);
    assert.match(open, /aria-label="Message"|>Message</);
    const working = renderToStaticMarkup(createElement(skin.Shell, { model: { ...shell, assistant: { ...assistantChat, thread: { ...assistantChat.thread!, working: true, status: { kind: "progress", label: "Working" } } } } }, "page"));
    assert.match(working, /Working/);
    const fresh = renderToStaticMarkup(createElement(skin.Shell, { model: { ...shell, assistant: { ...assistantChat, thread: null } } }, "page"));
    assert.match(fresh, /New conversation/);
  });

  test(`${skin.name}: the worlds list draws every row verb, refresh and create`, () => {
    checkSurface("Worlds", renderToStaticMarkup(createElement(skin.Worlds, { model: worlds })), worlds, skin.shellRefresh ? ["refresh"] : []);
  });

  test(`${skin.name}: the world page draws stop, invite, the overflow and each tab's verbs`, () => {
    // The tabs draw one at a time; each is rendered at its own tab.
    const details = renderToStaticMarkup(createElement(skin.World, { model: worldPage }));
    const wipes = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "wipes" } }));
    const backups = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "backups" } }));
    const releasesTab = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "releases" } }));
    const entry = worldPage.backups.inventory.status === "ready" ? worldPage.backups.inventory.value.entries[0]! : (null as never);
    checkSurface("World", details + wipes + backups + releasesTab, { ...worldPage, backups: { ...worldPage.backups, restore: worldPage.backups.restore(entry), download: worldPage.backups.download!(entry) } }, skin.shellRefresh ? ["refresh"] : []);
  });

  const tabWith = (model: Partial<WorldModel["releases"]> | { mods: ModsModel | null }) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "releases", releases: { ...worldPage.releases, ...model } } }));
  // The source filter: the console offers Source in its property menu, the terminal a radio per source.
  const sourceFilter = skin.name === "Terminal" ? /Filter mods by source/ : /c-filter-option[^>]*>\s*<span>Source<\/span>/;
  const pager = skin.name === "Terminal" ? /class="t-pager"/ : /class="c-pager"/;

  test(`${skin.name}: a world's files are its release's mods and its backup archives (ADR-0065)`, () => {
    const releasesTab = tabWith({});
    assert.match(releasesTab, /create-1\.20\.1-0\.5\.1\.j\.jar/, "the mods of the release the world starts with");
    assert.doesNotMatch(tabWith({ mods: null }), /Server mods/);
    assert.match(tabWith({ mods: modsModel({ files: { status: "error", error: "boom", kind: "failed", retry: spy("mods.retry", "Try again") } }) }), /data-action="mods\.retry"/);
    // The source of each mod is a mark with its name; a mod of an older release reads as unknown.
    assert.match(releasesTab, /CurseForge/);
    assert.match(releasesTab, /Unknown source/);
    assert.match(releasesTab, /Search mods/);
    assert.match(releasesTab, sourceFilter);
    // A release that recorded no source keeps the search and offers no source filter.
    const oldTab = tabWith({ mods: modsModel({ sources: [], files: { status: "ready", value: { rows: [{ ...modRows[1]!, file: "old.jar" }], total: 1, all: 1 } } }) });
    assert.match(oldTab, /Search mods/);
    assert.match(oldTab, /Unknown source/);
    assert.doesNotMatch(oldTab, sourceFilter);
    // Without backup.download, the archive is listed and never offered.
    const noDownload = renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "backups", backups: { ...worldPage.backups, download: null } } }));
    assert.doesNotMatch(noDownload, /data-action="backup\.download"/);
  });

  test(`${skin.name}: the mod list shows one page, its pager only when there are more pages, and every state of the list`, () => {
    assert.doesNotMatch(tabWith({}), pager, "one page draws no pager");
    const paged = tabWith({ mods: modsModel({ page: 2, pages: 8 }) });
    assert.match(paged, pager);
    assert.match(paged, /Previous page/);
    assert.match(paged, /Next page/);
    assert.match(paged, skin.name === "Terminal" ? /Page 2 of 8/ : /aria-current="page" aria-label="Page 2"/);
    const loading = tabWith({ mods: modsModel({ files: { status: "loading" } }) });
    assert.match(loading, /aria-busy="true"/);
    assert.match(loading, /Search mods/, "the search stays while a page loads");
    assert.match(tabWith({ mods: modsModel({ sources: [], files: { status: "ready", value: { rows: [], total: 0, all: 0 } } }) }), /No mods|has no mods/);
    const none = tabWith({ mods: modsModel({ search: "zzz", narrowed: true, files: { status: "ready", value: { rows: [], total: 0, all: 2 } } }) });
    assert.match(none, /No matches|No matching mods/, "a search that matched nothing is not an empty release");
    assert.match(none, /Clear filters/);
  });

  test(`${skin.name}: the mod list shows the sort and the search the server was asked for`, () => {
    const sorted = tabWith({ mods: modsModel({ search: "create", sort: { key: "size", direction: "descending" } }) });
    if (skin.name === "Terminal") {
      assert.match(sorted, /<option[^>]*value="size:descending"[^>]*selected|selected=""[^>]*value="size:descending"/);
      assert.match(sorted, /value="create"/);
    } else {
      assert.match(sorted, /aria-sort="descending"/);
      assert.equal(sorted.match(/aria-sort="/g)?.length, 1, "one sorted column");
      assert.match(sorted, /c-filter-token-key">Text: <\/span>create/);
    }
  });

  test(`${skin.name}: the downloads list the newest release first`, () => {
    const row = (name: string) => ({ name, status: "Active", downloadable: true, sourceHref: null, downloads: [spy("world.pack", "Download")] });
    const markup = tabWith({ rows: [row("7.2"), row("7.10"), row("7.9")] });
    const at = (name: string) => markup.indexOf(`>${name}<`);
    assert.ok(at("7.10") > 0 && at("7.10") < at("7.9") && at("7.9") < at("7.2"), "7.10, then 7.9, then 7.2");
  });

  test(`${skin.name}: a release's changes name each item with its change as a word, and every other state (P3)`, () => {
    const tab = (changes: WorldModel["releases"]["changes"]) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "releases", releases: { ...worldPage.releases, changes } } }));
    const ready = tab(worldPage.releases.changes);
    assert.match(ready, /1\.1 → 1\.2/, "the compared pair");
    for (const word of ["Removed", "Changed", "Added"]) assert.match(ready, new RegExp(`>${word}<`), `the change ${word} is a word, never colour alone`);
    assert.ok(ready.indexOf("oldmod-1.jar") < ready.indexOf("create-0.6.jar") && ready.indexOf("create-0.6.jar") < ready.indexOf("config/new.toml"), "losses lead");
    assert.match(tab({ release: "1.2", changes: { status: "ready", value: { from: null, unchanged: 0, rows: [] } } }), /No changes/);
    assert.match(tab({ release: "1.2", changes: { status: "ready", value: null } }), /Release 1\.2 has no build plan/);
    assert.match(tab({ release: "1.2", changes: { status: "error", error: "boom", kind: "failed", retry: spy("changes.retry", "Try again") } }), /data-action="changes\.retry"/);
    assert.doesNotMatch(tab(null), /No changes|build plan|1\.1 → 1\.2/);
  });

  test(`${skin.name}: a world's whitelist draws add, each player's remove, and what it means when empty or not kept (ADR-0066)`, () => {
    const tab = (model: WhitelistModel) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "whitelist", whitelist: model } }));
    const kept = tab(whitelist);
    checkSurface("Whitelist", kept, whitelist);
    assert.match(kept, /aria-invalid="true"/, "a name the game would refuse is marked before it is sent");
    assert.match(kept, /3 to 16 letters/);
    assert.doesNotMatch(kept, /does not keep this world/);
    // No list of its own: the server's names show as rows, and nothing explains it (the owner's no-copy rule).
    const unkept = tab({ ...whitelist, list: { status: "ready", value: { managed: false, updatedAt: null, updatedBy: null, rows: [] } } });
    assert.doesNotMatch(unkept, /does not keep this world|replaces the server/);
    assert.match(unkept, /No names/, "a stopped world with no list shows the empty state");
    const read = tab({ ...whitelist, list: { status: "ready", value: { managed: false, updatedAt: null, updatedBy: null, rows: whitelist.list.status === "ready" ? whitelist.list.value.rows : [] } } });
    assert.match(read, /Mira/, "the running server's names show as rows");
    assert.match(read, /data-action="whitelist\.remove\.Mira"/);
    assert.doesNotMatch(read, /does not keep this world|replaces the server/);
    const empty = tab({ ...whitelist, list: { status: "ready", value: { managed: true, updatedAt: null, updatedBy: null, rows: [] } } });
    assert.match(empty, /Nobody can join/);
    const failed = tab({ ...whitelist, list: { status: "error", error: "boom", kind: "failed", retry: spy("whitelist.retry", "Try again") } });
    assert.match(failed, /data-action="whitelist\.retry"/);
  });

  test(`${skin.name}: a world's config files list their files with the world's changes, and the open file draws its editor and every verb (ADR-0093)`, () => {
    const tab = (model: ConfigFilesModel) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "config", config: model } }));
    const list = tab(configFiles);
    checkSurface("Config files", list, configFiles);
    assert.match(list, /config\/claims\.toml/);
    assert.match(list, /Edited in this world/);
    assert.match(list, /The release changed this file after the edit/);
    assert.match(list, /data-action="config\.open\.config\/large\.bin"/, "a file the panel cannot open is still drawn, refused");
    assert.match(list, /Release 1\.3/);
    const open = tab({ ...configFiles, editor: configEditor });
    checkSurface("Config editor", open, configEditor);
    assert.match(open, /<textarea/);
    assert.match(open, /Contents of config\/claims\.toml/, "the editor is named by its file");
    assert.match(open, /max_chunks = 200/);
    assert.match(open, /next start/);
    assert.match(open, /Someone changed this file/);
    const quiet = tab({ ...configFiles, editor: { ...configEditor, reload: null, reset: null } });
    assert.doesNotMatch(quiet, /Someone changed this file|data-action="config\.reset"|data-action="config\.reload"/);
    const none = tab({ ...configFiles, list: { status: "ready", value: { release: null, rows: [] } } });
    assert.match(none, /No config files/);
    const failed = tab({ ...configFiles, list: { status: "error", error: "boom", kind: "failed", retry: spy("config.list.retry", "Try again") } });
    assert.match(failed, /data-action="config\.list\.retry"/);
    const unread = tab({ ...configFiles, editor: { ...configEditor, content: { status: "error", error: "boom", kind: "failed", retry: spy("config.retry", "Try again") } } });
    assert.match(unread, /data-action="config\.retry"/);
    assert.doesNotMatch(unread, /<textarea/);
  });

  test(`${skin.name}: a world's log draws its lines with their tones and Read log, and the Owner's assistant its models, question and answer (ADR-0094)`, () => {
    const tab = (model: WorldLogModel) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, tab: "log", log: model } }));
    const read = tab(worldLog);
    checkSurface("World log", read, worldLog);
    assert.match(read, /player-1 joined the game/);
    assert.match(read, /Warning: /, "a warning says so in text");
    assert.match(read, /Error: /);
    assert.doesNotMatch(read, /<time/, "a game's line keeps its own time");
    assert.match(read, /Haiku/);
    assert.match(read, /Sonnet/);
    assert.match(read, /Fast and cheap/, "a model's meaning is its tooltip");
    assert.match(read, /Why the lag\?/);
    assert.match(read, /throws every tick/);
    assert.match(tab({ ...worldLog, log: null }), /No log read/);
    const failed = tab({ ...worldLog, log: { status: "error", error: "boom", kind: "failed", retry: spy("log.retry", "Try again") } });
    assert.match(failed, /data-action="log\.retry"/);
    const unanswered = tab({ ...worldLog, assistant: { ...assistantPanel, answer: { status: "error", error: "boom", kind: "failed", retry: spy("assistant.retry", "Try again") } } });
    assert.match(unanswered, /data-action="assistant\.retry"/);
    const notOwner = tab({ ...worldLog, assistant: null });
    assert.doesNotMatch(notOwner, /data-action="assistant\.ask"|Sonnet/, "only an Owner sees the assistant");
  });

  test(`${skin.name}: the game settings sheet draws every kind of setting, its errors, save, defaults and cancel (ADR-0064)`, () => {
    const markup = renderToStaticMarkup(createElement(skin.GameSettingsSheet, { model: gameSettings }));
    checkSurface("GameSettings", markup, gameSettings);
    assert.match(markup, /Difficulty/);
    assert.match(markup, /A whole number from 1 to 100\./, "a field says why it cannot be saved");
    assert.match(markup, /aria-invalid="true"/);
    assert.match(markup, /uses|apply from its next start/, "a running world is told when the settings reach it");
  });

  test(`${skin.name}: a world's console and metrics tabs draw their verbs, and only that world's`, () => {
    // ADR-0062: several worlds of a game can run at once, so a console and a
    // host's metrics belong to one world's page, never to the game's menu.
    const worldTab = (model: Partial<WorldModel>) => renderToStaticMarkup(createElement(skin.World, { model: { ...worldPage, ...model } }));
    checkSurface("World console", worldTab({ tab: "console", console: rcon }), rcon);
    checkSurface("World console", worldTab({ tab: "console", console: rconUnreadable }), rconUnreadable);
    checkSurface("World metrics", worldTab({ tab: "metrics", metrics }), metrics);
    const noHost = worldTab({ tab: "metrics", metrics: metricsWithoutHost });
    assert.match(noHost, /No session in this window/, "a world that did not run shows no other world's host");
    const console = worldTab({ tab: "console", console: rcon });
    assert.match(console, new RegExp(world.displayName), "the console names the world it speaks to");
  });

  test(`${skin.name}: releases draw their verbs`, () => {
    checkSurface("Releases", renderToStaticMarkup(createElement(skin.Releases, { model: releases })), releases);
  });

  test(`${skin.name}: access draws approve, dismiss, delete, roles, invitations and subscriptions on their tabs`, () => {
    const users = renderToStaticMarkup(createElement(skin.Access, { model: access }));
    const roles = renderToStaticMarkup(createElement(skin.Access, { model: { ...access, tab: "roles" } }));
    const notifications = renderToStaticMarkup(createElement(skin.Access, { model: { ...access, tab: "notifications" } }));
    const toggles = { started: access.notifications.toggle("minecraft.started", "Minecraft started"), stopped: access.notifications.toggle("minecraft.stopped", "Minecraft stopped"), broadcast: access.notifications.toggle("invitation.broadcast", "Everyone"), direct: access.notifications.toggle("invitation.direct", "Me") };
    const role = access.roles.roles.status === "ready" ? access.roles.roles.value[0]! : (null as never);
    checkSurface("Access", users + roles + notifications, { ...access, toggles, read: access.roles.read(role) });
    // Every identity row has the same menu, also the caller's own row without delete.
    assert.match(users, /aria-label="Actions for DrArzter"/);
    assert.match(users, /aria-label="Actions for Mira"/);
    assert.doesNotMatch(users, /aria-label="Linked accounts"/, "linked accounts is a menu item on every row, never a lone button");
  });

  test(`${skin.name}: the profile draws sign out, the browser door and every sign-in method verb`, () => {
    const account = profile.loginAccounts.accounts.status === "ready" ? profile.loginAccounts.accounts.value[0]! : (null as never);
    checkSurface("Profile", renderToStaticMarkup(createElement(skin.Profile, { model: profile })), { ...profile, rowActions: profile.loginAccounts.rowActions(account) });
  });

  test(`${skin.name}: the profile offers Change picture always and Remove picture only with a picture`, () => {
    const withPicture = renderToStaticMarkup(createElement(skin.Profile, { model: profile }));
    assert.match(withPicture, /data-action="profile\.avatar\.change"/);
    assert.match(withPicture, /data-action="profile\.avatar\.remove"/);
    const without = renderToStaticMarkup(createElement(skin.Profile, { model: { ...profile, viewer: { displayName: "DrArzter", inTelegram: true }, avatar: { ...profile.avatar, remove: null } } }));
    assert.match(without, /data-action="profile\.avatar\.change"/);
    assert.doesNotMatch(without, /profile\.avatar\.remove/);
    // The picture is the menu's button, in the page head; no card of its own.
    assert.match(withPicture, /<button[^>]*aria-haspopup="menu"[^>]*aria-label="Change your picture"/);
    assert.doesNotMatch(withPicture, />Picture</);
  });

  test(`${skin.name}: dialogs and sheets draw confirm, cancel, submit, save, send and close`, () => {
    checkSurface("Confirmation", renderToStaticMarkup(createElement(skin.ConfirmationDialog, { model: confirmation })), confirmation);
    const typed = renderToStaticMarkup(createElement(skin.ConfirmationDialog, { model: { ...confirmation, typedConfirmation: { ...confirmation.typedConfirmation!, label: "User name" } } }));
    assert.match(typed, /User name/, "the typed field is named by the model, not by the skin");
    assert.doesNotMatch(typed, /to confirm/, "the field and its placeholder say what to type; no second line");
    const refused = renderToStaticMarkup(createElement(skin.ConfirmationDialog, { model: { ...confirmation, error: "The last Owner cannot be deleted." } }));
    assert.match(refused, /role="alert"[^>]*>The last Owner cannot be deleted\./, "a refusal is read inside the open dialog");
    checkSurface("CreateWorld", renderToStaticMarkup(createElement(skin.CreateWorldSheet, { model: createWorld })), createWorld);
    checkSurface("WorldSettings", renderToStaticMarkup(createElement(skin.WorldSettingsSheet, { model: worldSettings })), worldSettings);
    checkSurface("Invitation", renderToStaticMarkup(createElement(skin.InvitationSheet, { model: invitation })), invitation);
  });
}

test("the action collector finds actions wherever a model keeps them", () => {
  const nested = { a: spy("one", "One"), list: [{ deep: spy("two", "Two") }], fn: () => spy("three", "Three") };
  assert.deepEqual(actionsOf(nested).map((item) => item.id), ["one", "two"], "functions are not walked: an action a skin must call for is asked for in the test");
});
