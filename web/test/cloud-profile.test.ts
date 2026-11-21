import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action, type Action } from "../src/core/actions.ts";
import type { ConfirmationModel, ConnectionFieldsModel, CreateWorldModel, GameSettingsModel, ProfileModel, WorldSettingsModel } from "../src/core/models.ts";
import type { Game, World } from "../src/model.ts";
import { ConfirmationDialog, CreateWorldSheet, GameSettingsSheet, WorldSettingsSheet } from "../src/skins/cloud/Dialogs.tsx";
import { Profile } from "../src/skins/cloud/Profile.tsx";

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
  look: { current: "cloud", options: [{ id: "terminal", name: "Terminal", choose: spy("look.terminal", "Terminal") }] },
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

test("profile: the name is the title at the start, the role chip leads the end-edge actions", () => {
  const markup = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.match(markup, /<h1[^>]*>Kai Ashby/);
  assert.match(markup, /class="c-page-actions"><span class="c-chip"[^>]*>.*?Owner/);
  assert.match(markup, /aria-label="Copy identity ID"/);
});

test("profile: Appearance holds the theme as three radio cards and the looks as Actions", () => {
  const markup = renderToStaticMarkup(createElement(Profile, { model: profile }));
  assert.equal(markup.match(/name="theme"/g)?.length, 3);
  assert.match(markup, /value="dark"[^>]*checked|checked=""[^>]*value="dark"/);
  assert.match(markup, /data-action="look\.terminal"/);
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

test("confirmation: the typed field is named by the model and cued with the expected value", () => {
  const model: ConfirmationModel = { title: "Delete Rostik?", description: "Deletes every backup.", destructive: true, confirm: spy("confirm", "Delete", { disabled: true }), cancel: spy("cancel", "Cancel"), releaseChoice: null, typedConfirmation: { label: "World ID", expected: world.id, value: "", set: noop } };
  const markup = renderToStaticMarkup(createElement(ConfirmationDialog, { model }));
  assert.match(markup, /<label[^>]*>World ID<\/label>/);
  assert.match(markup, new RegExp(`Type <span class="c-mono">${world.id}</span> to confirm`));
  assert.match(markup, /class="c-btn c-btn-danger"/);
});

test("connection fields: a fleet world is public and cannot pick ZeroTier; a persistent one is the reverse", () => {
  const settings = (connection: ConnectionFieldsModel): WorldSettingsModel => ({ game, world, stopped: true, connection, valid: true, save: spy("world.settings.save", "Save settings"), cancel: spy("sheet.close", "Cancel") });
  const onFleet = renderToStaticMarkup(createElement(WorldSettingsSheet, { model: settings(fleet) }));
  assert.match(onFleet, /The game port is public\./);
  assert.match(onFleet, /disabled=""[^>]*value="zerotier"|value="zerotier"[^>]*disabled=""/);
  const onPersistent = renderToStaticMarkup(createElement(WorldSettingsSheet, { model: settings(persistent) }));
  assert.doesNotMatch(onPersistent, /The game port is public/);
  assert.match(onPersistent, /disabled=""[^>]*value="raw"|value="raw"[^>]*disabled=""/);
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
  assert.match(markup, /class="c-btn c-btn-ghost c-sheet-defaults"[^>]*data-action="game-settings\.defaults"/);
  assert.match(markup, /data-action="game-settings\.pvp"[^>]*role="switch"/);
  assert.doesNotMatch(markup, /apply from its next start/, "the line shows only while the world runs");
});
