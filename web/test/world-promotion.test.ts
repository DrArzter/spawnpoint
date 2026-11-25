import "./support/browser.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmationCopy } from "../src/core/forms.ts";
import { neverStarted, promotionTargets, rowActions, worldMoreActions, type WorldCallbacks } from "../src/core/worlds.ts";
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
    materialization: "existing", wipes: [], connectionAddress: null,
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

test("it is refused while players are online, with no newer release, before a first start, or while busy", () => {
  const playing = world({ session: session(2) });
  assert.equal(promote(playing).fromPage?.disabled, true);
  assert.equal(promote(playing).fromPage?.detail, "Refused while players are online");
  assert.equal(promote(world({ session: session(0) })).fromPage?.disabled, false);
  const only = world({ preset: { ...preset, releases: ["100.1"], latestRelease: "100.1" } });
  assert.equal(promote(only).fromPage?.detail, "No newer built release");
  const legacy = promote(world({ release: { state: "available", generationId: null, desiredRelease: "100.1", activeRelease: null } })).fromPage;
  assert.equal(legacy?.disabled, true);
  assert.equal(legacy?.detail, "Available once a release is active");
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

test("only releases after the active one are offered; going back is a restore", () => {
  const releases = ["1.1", "2.1", "3.1"];
  const game = { presets: [{ id: "p", releases, buildStatus: "ready" }] } as unknown as Parameters<typeof promotionTargets>[0];
  const world = { preset: { id: "p" }, release: { activeRelease: "2.1" } } as unknown as Parameters<typeof promotionTargets>[1];
  assert.deepEqual(promotionTargets(game, world), ["3.1"]);
});

// ADR-0078, amended: a wipe that never started holds no save, so its release may change.
const unstarted = (values: Partial<World> = {}) => world({
  release: { state: "available", generationId: `gen-${"c".repeat(32)}`, desiredRelease: "200.1", activeRelease: null, runCount: 0 },
  ...values,
});

test("a never-started world finds Update release enabled, in the page menu and on the row", () => {
  const { fromPage, fromRow, promoted } = promote(unstarted());
  for (const item of [fromPage, fromRow]) {
    assert.equal(item?.label, "Update release");
    assert.equal(item?.disabled, false);
    assert.equal(item?.detail, "Switches the release before the first start");
  }
  fromRow?.run();
  assert.deepEqual(promoted, ["prom"]);
  assert.equal(neverStarted(unstarted()), true);
});

test("its targets are every release a new world may use, newest first, except the one it names", () => {
  assert.deepEqual(promotionTargets(gameOf(unstarted()), unstarted()), ["300.1", "100.1"]);
  const older = unstarted({ preset: { ...preset, olderReleases: ["100.1"] } });
  assert.deepEqual(promotionTargets(gameOf(older), older), ["300.1"]);
  const building = { ...gameOf(unstarted()), presets: [{ ...preset, buildStatus: "building" as const }] };
  assert.deepEqual(promotionTargets(building, unstarted()), ["300.1", "100.1"], "a new world needs a release, not a finished build");
});

test("a world that ran, or has an active release, keeps the promotion rules", () => {
  const ran = world({ release: { state: "available", generationId: `gen-${"c".repeat(32)}`, desiredRelease: "100.1", activeRelease: null, runCount: 1 } });
  assert.equal(neverStarted(ran), false);
  assert.equal(promote(ran).fromPage?.detail, "Available once a release is active");
  assert.equal(neverStarted(world()), false);
  assert.deepEqual(promotionTargets(gameOf(world()), world()), ["300.1", "200.1"]);
});

test("a never-started world stays refused while busy, while a session runs, or with no other release", () => {
  assert.equal(promote(unstarted(), OWNER, true).fromPage?.disabled, true);
  const running = unstarted({ session: session(0) });
  assert.equal(promote(running).fromPage?.disabled, true);
  assert.equal(promote(running).fromPage?.detail, "Refused while a session runs");
  const only = unstarted({ preset: { ...preset, releases: ["200.1"], latestRelease: "200.1" } });
  assert.equal(promote(only).fromPage?.detail, "No other built release");
});

test("its dialog is not destructive, needs no typed ID and says nothing is backed up", () => {
  const confirmation: Confirmation = { kind: "promote", game: gameOf(unstarted()), world: unstarted(), preset };
  const copy = confirmationCopy(confirmation);
  assert.equal(copy.destructive, false);
  assert.match(copy.description, /before the first start/);
  assert.doesNotMatch(copy.description, /Keeps the save/);
});
