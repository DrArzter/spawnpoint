import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { action } from "../src/core/actions.ts";
import type { ReleasesModel } from "../src/core/models.ts";
import { promotableReleases, startableLatest, startableReleases } from "../src/core/presets.ts";
import { presetBuildStates } from "../src/core/status.ts";
import { promotionTargets, worldMoreActions, rowActions, type WorldCallbacks } from "../src/core/worlds.ts";
import type { Game, Preset, World } from "../src/model.ts";
import { SKINS } from "../src/skins/index.ts";

// ADR-0042: a preset keeps the releases it published across revisions; the
// panel shows them as ready and the build of the new revision beside them.

const base: Preset = {
  id: "prominence", displayName: "Prominence II", repository: "https://github.com/x/y", commit: "a".repeat(40), profileDigest: "b".repeat(64),
  releases: ["39127124115.1"], olderReleases: ["39127124115.1"], latestRelease: "39127124115.1", buildStatus: "unbuilt",
};

test("a preset with only older releases is ready, and the new revision's build is a second compact state", () => {
  assert.deepEqual(presetBuildStates(base), { status: { kind: "ok", label: "Ready" }, revision: { kind: "absent", label: "New revision: not built" } });
  assert.deepEqual(presetBuildStates({ ...base, buildStatus: "failed" }).revision, { kind: "error", label: "New revision: build failed" });
  assert.deepEqual(presetBuildStates({ ...base, buildStatus: "building" }).revision, { kind: "progress", label: "New revision: building" });
  const dispatching = presetBuildStates({ ...base, build: { release: "1.0", attempt: 1, state: "starting", requestedAt: "2026-11-22T09:00:00Z" } });
  assert.equal(dispatching.revision?.label, "New revision: awaiting dispatch");
});

test("a preset whose current revision is built, or that has no release, keeps its single state", () => {
  assert.deepEqual(presetBuildStates({ ...base, buildStatus: "ready", releases: ["39127124115.1", "2.1"], latestRelease: "2.1" }), { status: { kind: "ok", label: "Ready" }, revision: null });
  assert.deepEqual(presetBuildStates({ ...base, releases: [], olderReleases: [], latestRelease: null }), { status: { kind: "absent", label: "Not built" }, revision: null });
  assert.deepEqual(presetBuildStates({ ...base, olderReleases: undefined, buildStatus: "failed" }), { status: { kind: "error", label: "Build failed" }, revision: null });
});

test("a new world or wipe opens on the current revision only; a promotion may use an older release", () => {
  assert.deepEqual(startableReleases(base), []);
  assert.equal(startableLatest(base), null);
  assert.deepEqual(promotableReleases(base), ["39127124115.1"]);
  const mixed: Preset = { ...base, releases: ["39127124115.1", "2.1"], latestRelease: "2.1", buildStatus: "ready" };
  assert.deepEqual(startableReleases(mixed), ["2.1"]);
  assert.equal(startableLatest(mixed), "2.1");
  assert.deepEqual(promotableReleases({ ...mixed, buildStatus: "building" }), ["39127124115.1"]);
});

function world(preset: Preset, activeRelease: string): World {
  return {
    id: "prom", displayName: "Prominence", profileId: "prominence", sessionControlAvailable: true, connectivity: "route53", placement: "fleet", auth: "game",
    materialization: "existing", wipes: [], connectionAddress: null, preset,
    release: { state: "available", generationId: `gen-${"c".repeat(32)}`, desiredRelease: activeRelease, activeRelease }, session: null,
  };
}
const gameOf = (preset: Preset, target: World): Game => ({ id: "minecraft", code: "MC", displayName: "Minecraft", lifecycle: null, presets: [preset], worlds: [target] });
const OWNER = new Set(["release.promote", "world.manage", "connection.read"]);
const callbacks: WorldCallbacks = { onWorldAction: () => {}, onInvite: () => {}, onDownloadPack: () => {}, onPromote: () => {} };

test("a world on an older-revision release keeps its actions, except a new wipe", () => {
  const preset: Preset = { ...base, releases: ["100.1", "200.1"], olderReleases: ["100.1", "200.1"], latestRelease: "200.1", buildStatus: "failed" };
  const target = world(preset, "100.1");
  assert.deepEqual(promotionTargets(gameOf(preset, target), target), ["200.1"]);
  const items = worldMoreActions(gameOf(preset, target), target, OWNER, false, callbacks);
  assert.equal(items.find((item) => item.id === "world.promote")?.disabled, false);
  const wipe = rowActions(gameOf(preset, target), target, OWNER, false, callbacks).find((item) => item.id === "world.wipe");
  assert.equal(wipe?.disabled, true, "a wipe needs a release of the current revision");
  assert.equal(items.find((item) => item.id === "world.pack")?.disabled, false, "the pack of the running release stays downloadable");
});

const game: Game = gameOf(base, world(base, "39127124115.1"));
const states = presetBuildStates({ ...base, buildStatus: "failed" });
const releases: ReleasesModel = {
  game, loading: false,
  presets: [{ preset: { ...base, buildStatus: "failed" }, ...states, createWorld: action("world.create", "Create world", () => {}, { disabled: true }), build: action("release.build", "Build new release", () => {}) }],
  pointers: [],
};

for (const skin of Object.values(SKINS)) {
  test(`${skin.name}: Releases shows the release as ready and the new revision's build as one indicator`, () => {
    const markup = renderToStaticMarkup(createElement(skin.Releases, { model: releases }));
    assert.match(markup, /New revision: build failed/, "the state is in the tooltip and the accessible text");
    assert.doesNotMatch(markup, /Not built/);
    assert.match(markup, /39127124115\.1/);
    assert.match(markup, /data-action="release\.build"/, "the build verb stays reachable");
  });
}
