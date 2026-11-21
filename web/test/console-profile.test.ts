import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action, type Action } from "../src/core/actions.ts";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingsModel, InvitationModel, ProfileModel, WorldSettingsModel } from "../src/core/models.ts";
import type { Game, World } from "../src/model.ts";
import { ConfirmationDialog, CreateWorldSheet, GameSettingsSheet, InvitationSheet, WorldSettingsSheet } from "../src/skins/console/Dialogs.tsx";
import { Profile } from "../src/skins/console/Profile.tsx";

const noop = () => undefined;
const spy = (id: string, label: string, rest: Partial<Action> = {}): Action => action(id, label, noop, rest);

const world = { id: "minecraft-rostik-12345678", displayName: "Rostik", connectivity: "zerotier", placement: "configured" } as unknown as World;
const game = {
  id: "minecraft",
  code: "MC",
  displayName: "Minecraft",
  presets: [{ id: "industrial", displayName: "Industrial", buildStatus: "ready", latestRelease: "1.2", releases: ["1.1", "1.2"] }],
  worlds: [world],
} as unknown as Game;

const profile: ProfileModel = {
  member: { id: "m1", name: "Kai Ashby", roleId: "owner", links: [] },
  role: { id: "owner", name: "Owner", description: "Everything", permissions: ["a"] },
  viewer: { displayName: "Kai Ashby", inTelegram: false },
  appearance: { preference: "dark", theme: "dark", accent: "#5b47d6", setPreference: async () => undefined, setAccent: async () => undefined },
  look: { current: "console", options: [{ id: "terminal", name: "Terminal", choose: spy("look.terminal", "Terminal") }] },
  signOut: spy("profile.signout", "Sign out"),
  openInBrowser: null,
  loginAccounts: {
    accounts: { status: "ready", value: [{ provider: "password", subject: "p", displayName: null, username: null, email: "kai@example.test", photoUrl: null, verified: true }] },
    linkable: ["telegram"],
    connectTelegram: null,
    connectGoogle: null,
    addPassword: null,
    form: null,
    rowActions: () => [spy("accounts.password.change", "Change password"), spy("accounts.password.reset", "Send reset link")],
  },
} as ProfileModel;

const fleet: ConnectionFieldsModel = { placement: "fleet", setPlacement: noop, fleetAvailable: true, connectivity: "raw", setConnectivity: noop, dnsAvailable: true };
const persistent: ConnectionFieldsModel = { ...fleet, placement: "configured", connectivity: "zerotier" };

test("profile: the name is the title, the role chip follows it at the start, and the verbs keep the end edge", () => {
  const markup = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.match(markup, /<h1[^>]*>Kai Ashby/);
  assert.match(markup, /<\/nav><span class="c-chip"[^>]*>.*?Owner/, "the role sits after the title");
  assert.doesNotMatch(markup.slice(markup.indexOf('class="c-page-actions"')), /c-chip/, "no chip among the verbs");
  assert.match(markup, /aria-label="Copy identity ID"/);
  const roleless = renderToStaticMarkup(createElement(Profile, { model: { ...profile, role: undefined } }));
  assert.doesNotMatch(roleless, /c-chip/, "no role, no chip");
});

test("profile: Appearance holds the theme and the looks as radio cards, each look carrying its Action", () => {
  const markup = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.equal(markup.match(/name="theme"/g)?.length, 3);
  assert.match(markup, /value="dark"[^>]*checked|checked=""[^>]*value="dark"/);
  assert.match(markup, /data-action="look\.terminal"[^>]*name="look"[^>]*type="radio"|name="look"[^>]*data-action="look\.terminal"|data-action="look\.terminal"[^>]*type="radio"/);
  const onTerminal = renderToStaticMarkup(createElement(Profile, { model: { ...profile, look: { ...profile.look, current: "terminal" } } }));
  assert.match(onTerminal, /checked=""[^>]*data-action="look\.terminal"|data-action="look\.terminal"[^>]*checked=""|checked=""[^>]*name="look"/, "the current look reads as chosen");
});

test("profile: the accent well shows the picked colour, and Reset is refused while the default is in use", () => {
  const picked = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.match(picked, /<label[^>]*>Accent<\/label>/);
  assert.match(picked, /type="color"[^>]*value="#5b47d6"|value="#5b47d6"[^>]*type="color"/);
  assert.doesNotMatch(picked.match(/<button[^>]*data-action="appearance\.accent\.reset"[^>]*>/)?.[0] ?? "", /aria-disabled/);
  const plain = renderToStaticMarkup(createElement(Profile, { model: { ...profile, appearance: { ...profile.appearance, accent: "#1a73e8" } } }));
  assert.match(plain.match(/<button[^>]*data-action="appearance\.accent\.reset"[^>]*>/)?.[0] ?? "", /aria-disabled="true"/);
  assert.match(plain, /type="color"[^>]*value="#5b47d6"|value="#5b47d6"[^>]*type="color"/, "without a pick the well shows the iris");
});

test("profile: sign-in methods share one track list with one action column", () => {
  const markup = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.equal(markup.match(/class="c-tracklist"/g)?.length, 1);
  assert.match(markup, /data-action="accounts\.password\.change"[^>]*class="c-btn c-btn-default c-btn-sm"|class="c-btn c-btn-default c-btn-sm"[^>]*data-action="accounts\.password\.change"/);
  assert.match(markup, /aria-label="More for Email"/, "a second verb goes to the row's overflow");
  assert.match(markup, /Telegram.*Not linked/, "a linkable method that is not linked has its own row");
});

test("profile: the password form is a side panel with its fields and Actions", () => {
  const form = { kind: "change" as const, email: "kai@example.test", setEmail: noop, currentPassword: "", setCurrentPassword: noop, password: "", setPassword: noop, confirmation: "", setConfirmation: noop, error: "The passwords differ.", busy: false, submit: spy("accounts.password.submit", "Change password"), cancel: spy("accounts.password.cancel", "Cancel") };
  const markup = renderToStaticMarkup(createElement(Profile, { model: { ...profile, loginAccounts: { ...profile.loginAccounts, form } } }));
  assert.match(markup, /<dialog[^>]*class="c-panel"/);
  assert.match(markup, /Current password/);
  assert.doesNotMatch(markup, /type="email"/, "a password change does not ask for the email");
  assert.match(markup, /role="alert"[^>]*>.*The passwords differ\./);
});

test("confirmation: the typed field is named by the model and its placeholder is the expected value", () => {
  const model: ConfirmationModel = { title: "Delete Rostik?", description: "Deletes every backup.", destructive: true, confirm: spy("confirm", "Delete", { disabled: true }), cancel: spy("cancel", "Cancel"), releaseChoice: null, typedConfirmation: { label: "World ID", expected: world.id, value: "", set: noop } };
  const markup = renderToStaticMarkup(createElement(ConfirmationDialog, { model }));
  assert.match(markup, /<label[^>]*>World ID<\/label>/);
  assert.match(markup, new RegExp(`placeholder="${world.id}"`));
  assert.doesNotMatch(markup, /to confirm/, "no second line restates the field");
  assert.match(markup, /class="c-btn c-btn-danger"/);
});

test("connection fields: a fleet world is public and cannot pick ZeroTier; a persistent one is the reverse", () => {
  const settings = (connection: ConnectionFieldsModel): WorldSettingsModel => ({ game, world, stopped: true, connection, valid: true, save: spy("world.settings.save", "Save settings"), cancel: spy("sheet.close", "Cancel") });
  const onFleet = renderToStaticMarkup(createElement(WorldSettingsSheet, { model: settings(fleet) }));
  assert.match(onFleet, /The game port is public\.<\/strong><span aria-label="Set the game[^"]*" class="c-notice-more"/, "the details live in a tooltip, not on the line");
  assert.match(onFleet, /aria-disabled="true"[^>]*value="zerotier"/);
  const onPersistent = renderToStaticMarkup(createElement(WorldSettingsSheet, { model: settings(persistent) }));
  assert.doesNotMatch(onPersistent, /The game port is public/);
  assert.match(onPersistent, /aria-disabled="true"[^>]*value="raw"/);
});

test("create world: with no ready preset the preset row points to Releases", () => {
  const unbuilt = { ...game, presets: [{ ...game.presets[0]!, releases: [], buildStatus: "unbuilt" }] } as unknown as Game;
  const model: CreateWorldModel = { game: unbuilt, presets: unbuilt.presets, presetId: "industrial", setPresetId: noop, preset: null, name: "", setName: noop, release: "", setRelease: noop, connection: persistent, valid: false, submit: spy("world.create", "Create world", { disabled: true }), cancel: spy("sheet.close", "Cancel") };
  const markup = renderToStaticMarkup(createElement(CreateWorldSheet, { model }));
  assert.match(markup, /No ready preset/);
  assert.match(markup, /href="#\/releases\/minecraft"/);
});

test("game settings: Restore defaults leads the footer, the switch carries its Action", () => {
  const model: GameSettingsModel = { game, world, running: false, fields: [{ id: "pvp", label: "PvP", kind: "toggle", checked: false, toggle: spy("game-settings.pvp", "PvP") }], save: spy("game-settings.save", "Save settings"), restoreDefaults: spy("game-settings.defaults", "Restore defaults"), cancel: spy("sheet.close", "Cancel") };
  const markup = renderToStaticMarkup(createElement(GameSettingsSheet, { model }));
  assert.match(markup, /class="c-dialog-start"><button class="c-btn c-btn-ghost"[^>]*data-action="game-settings\.defaults"/);
  assert.match(markup, /data-action="game-settings\.pvp"[^>]*role="switch"/);
  assert.doesNotMatch(markup, /apply from its next start/, "the line shows only while the world runs");
});

test("game settings: a running world gets the one line about its next start", () => {
  const model: GameSettingsModel = { game, world, running: true, fields: [], save: spy("game-settings.save", "Save settings"), restoreDefaults: spy("game-settings.defaults", "Restore defaults"), cancel: spy("sheet.close", "Cancel") };
  assert.match(renderToStaticMarkup(createElement(GameSettingsSheet, { model })), /<p class="c-line">Saved settings apply from its next start\.<\/p>/);
});

test("confirmation: a release choice is a Select with the latest marked, and a blank value asks for one", () => {
  const base: ConfirmationModel = { title: "Start a new wipe?", description: "", destructive: false, confirm: spy("confirm", "Start new wipe"), cancel: spy("cancel", "Cancel"), releaseChoice: { value: "1.2", options: [{ version: "1.2", latest: true }, { version: "1.1", latest: false }], set: noop }, typedConfirmation: null };
  const chosen = renderToStaticMarkup(createElement(ConfirmationDialog, { model: base }));
  assert.match(chosen, /<option value="1\.2"[^>]*>1\.2 · latest<\/option>/);
  assert.match(chosen, /class="c-btn c-btn-primary"/);
  assert.doesNotMatch(chosen, /<p class="c-line">/, "no empty description line");
  const blank = renderToStaticMarkup(createElement(ConfirmationDialog, { model: { ...base, releaseChoice: { ...base.releaseChoice!, value: "" } } }));
  assert.match(blank, /<option disabled="" value=""[^>]*>Choose a release<\/option>/);
});

test("invitation: direct lists players with a checkbox, marks the unreachable, and keeps history with its refresh", () => {
  const model: InvitationModel = {
    game, world, audience: "direct", setAudience: noop, query: "", setQuery: noop,
    recipients: { status: "ready", value: [
      { id: "r1", displayName: "Lena", ready: true, delivery: "Telegram", selected: true, toggle: noop },
      { id: "r2", displayName: "Mira", ready: false, delivery: "No Telegram chat", selected: false, toggle: noop },
    ] },
    reachable: 1, selectedCount: 1,
    clearSelection: spy("invitation.clear", "Clear selection"),
    history: { status: "ready", value: [{ id: "h1", status: { kind: "ok", label: "Delivered" }, audience: "Everyone", detail: "2/2 delivered", createdAt: "2026-11-20T10:00:00Z" }] },
    refreshHistory: spy("invitation.history.refresh", "Refresh"),
    send: spy("invitation.send", "Send invitation"),
    close: spy("sheet.close", "Cancel"),
  };
  const markup = renderToStaticMarkup(createElement(InvitationSheet, { model }));
  assert.match(markup, /aria-checked="true"[^>]*role="radio"[^>]*><span>Direct/);
  assert.equal(markup.match(/type="checkbox"/g)?.length, 2);
  assert.match(markup, /disabled=""[^>]*type="checkbox"|type="checkbox"[^>]*disabled=""/, "an unreachable player cannot be picked");
  assert.match(markup, /aria-label="No reachable channel · No Telegram chat"/);
  assert.match(markup, /1 of 1/);
  assert.match(markup, /2\/2 delivered/);
  for (const id of ["invitation.clear", "invitation.history.refresh", "invitation.send"]) assert.match(markup, new RegExp(`data-action="${id.replaceAll(".", "\\.")}"`));
  const broadcast = renderToStaticMarkup(createElement(InvitationSheet, { model: { ...model, audience: "broadcast" } }));
  assert.doesNotMatch(broadcast, /type="checkbox"/, "broadcast has no player list");
});
