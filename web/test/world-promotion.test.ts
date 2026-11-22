import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmationCopy } from "../src/core/forms.ts";
import { promotionTargets, rowActions, worldMoreActions, type WorldCallbacks } from "../src/core/worlds.ts";
import type { Game, Preset, World, WorldSession } from "../src/model.ts";
import type { Confirmation } from "../src/shell/actions.ts";

// ADR-0078: the Owner moves a fleet world's open wipe to another release of its preset.

const preset: Preset = {
  id: "prominence", displayName: "Prominence II", repository: "https://github.com/x/y", commit: "a".repeat(40), profileDigest: "b".repeat(64),
  releases: ["100.1", "200.1", "300.1"], buildStatus: "ready", latestRelease: "300.1",
};

function session(players: number | null): WorldSession {
  return {
    serverId: "world#prom", desiredState: "running", observedState: "ready", activeSessionId: "session-prom", activeWorldId: "prom",
    updatedAtEpochSeconds: 1, idle: players === null ? null : { playersOnline: players, consecutiveEmpty: 0, lastObservedAtEpochSeconds: 1 },
  };
}

function world(values: Partial<World> = {}): World {
  return {
    id: "prom", displayName: "Prominence", profileId: "prominence", sessionControlAvailable: true, connectivity: "route53", placement: "fleet", auth: "game",
    materialization: "existing", worldLifecycleAvailable: true, wipes: [], connectionAddress: null,
    preset: { ...preset },
    release: { state: "available", generationId: `gen-${"c".repeat(32)}`, desiredRelease: "100.1", activeRelease: "100.1" },
    session: null, ...values,
  };
}

const gameOf = (target: World): Game => ({ id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [{ ...preset, ...target.preset }], worlds: [target] });
const OWNER = new Set(["release.promote", "world.manage", "connection.read"]);

function callbacks(promoted: string[]): WorldCallbacks {
  return {
    onWorldAction: () => {}, onInvite: () => {}, onDownloadPack: () => {},
    onPromote: (_game, target) => { promoted.push(target.id); },
  };
}

function promote(target: World, granted: ReadonlySet<string> = OWNER, busy = false, withCallback = true) {
  const promoted: string[] = [];
  const handlers = withCallback ? callbacks(promoted) : { ...callbacks(promoted), onPromote: undefined };
  const fromPage = worldMoreActions(gameOf(target), target, granted, busy, handlers).find((item) => item.id === "world.promote");
  const fromRow = rowActions(gameOf(target), target, granted, busy, handlers).find((item) => item.id === "world.promote");
  return { fromPage, fromRow, promoted };
}

test("the Owner finds Update release on a fleet world's page and row, and it opens the confirmation", () => {
  const { fromPage, fromRow, promoted } = promote(world());
  assert.equal(fromPage?.label, "Update release");
  assert.equal(fromPage?.disabled, false);
  assert.equal(fromRow?.label, "Update release");
  fromPage?.run();
  assert.deepEqual(promoted, ["prom"]);
});

test("only release.promote, a deployment that promotes, and an existing fleet world show it", () => {
  assert.equal(promote(world(), new Set(["world.manage", "connection.read"])).fromPage, undefined);
  assert.equal(promote(world(), OWNER, false, false).fromPage, undefined);
  assert.equal(promote(world({ placement: "configured", connectivity: "zerotier" })).fromPage, undefined);
  assert.equal(promote(world({ materialization: "archived" })).fromPage, undefined);
});

test("it is refused while players are online, with no other release, before a first start, or while busy", () => {
  const playing = world({ session: session(2) });
  assert.equal(promote(playing).fromPage?.disabled, true);
  assert.equal(promote(playing).fromPage?.detail, "Refused while players are online");
  assert.equal(promote(world({ session: session(0) })).fromPage?.disabled, false);
  const only = world({ preset: { ...preset, releases: ["100.1"], latestRelease: "100.1" } });
  assert.equal(promote(only).fromPage?.detail, "No other built release");
  assert.equal(promote(world({ release: { state: "available", generationId: null, desiredRelease: "100.1", activeRelease: null } })).fromPage?.disabled, true);
  assert.equal(promote(world(), OWNER, true).fromPage?.disabled, true);
});

test("the targets are the preset's other releases, newest first, and none while the preset is building", () => {
  assert.deepEqual(promotionTargets(gameOf(world()), world()), ["300.1", "200.1"]);
  const building = { ...gameOf(world()), presets: [{ ...preset, buildStatus: "building" as const }] };
  assert.deepEqual(promotionTargets(building, world()), []);
});

test("the dialog keeps the save, names the release that stays on failure, and says players block it", () => {
  const confirmation: Confirmation = { kind: "promote", game: gameOf(world()), world: world(), preset };
  const copy = confirmationCopy(confirmation);
  assert.equal(copy.label, "Update release");
  assert.equal(copy.destructive, true);
  assert.match(copy.description, /Keeps the save/);
  assert.match(copy.description, /100\.1 stays/);
  assert.match(copy.description, /Refused while players are online/);
});
