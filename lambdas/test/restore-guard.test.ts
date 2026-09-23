import assert from "node:assert/strict";
import test from "node:test";

import { releaseManifestKey } from "../src/control-plane/release-artifacts.ts";
import { restoreWithPublishedRelease } from "../src/control-plane/restore-guard.ts";
import { archiveWorldRecord, newWorldRecord, regenerateWorldRecord } from "../src/control-plane/world-registry.ts";
import type { PresetObservation } from "../src/control-plane/preset-catalog.ts";

const preset: PresetObservation = {
  id: "industrial", displayName: "Industrial", gameId: "minecraft",
  repository: "https://github.com/DrArzter/config", commit: "a".repeat(40), profileDigest: "b".repeat(64),
  buildStatus: "ready", releases: ["1.2", "1.3"], latestRelease: "1.3",
};
const initial = newWorldRecord(preset, { worldId: "rostik", displayName: "Rostik", release: "1.2" },
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "2026-09-01T00:00:00Z");
const current = regenerateWorldRecord(initial, preset, "1.3", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "2026-09-02T00:00:00Z");
const world = archiveWorldRecord(current);
const backup = {
  key: `worlds/rostik/archives/rostik-${initial.currentGeneration.id}-20260901T173200Z-${"c".repeat(64)}.tar.zst`,
  checksum: "c".repeat(64), generationId: initial.currentGeneration.id,
};
const restoreUuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";

test("restore checks the source generation's release, not the currently active one", async () => {
  const asked: string[] = [];
  const restored = await restoreWithPublishedRelease(world, backup, restoreUuid, "2026-09-03T00:00:00Z", async (game, selectedPreset, release) => {
    asked.push(releaseManifestKey(game, selectedPreset, release));
    return true;
  });
  assert.deepEqual(asked, ["releases/minecraft/industrial/1.2/manifest.json"]);
  assert.equal(restored.currentGeneration.release, "1.2");
  assert.equal(world.currentGeneration.release, "1.3", "preflight does not mutate the source record");
});

test("missing source release refuses restore before the caller can write the generation", async () => {
  await assert.rejects(restoreWithPublishedRelease(world, backup, restoreUuid, "2026-09-03T00:00:00Z", async () => false), /release_missing/);
});

test("an unrelated backup is rejected before any release lookup", async () => {
  let checked = false;
  const unknownGeneration = `gen-${"d".repeat(32)}`;
  const unrelated = { ...backup, generationId: unknownGeneration, key: backup.key.replace(initial.currentGeneration.id, unknownGeneration) };
  await assert.rejects(restoreWithPublishedRelease(world, unrelated, restoreUuid,
    "2026-09-03T00:00:00Z", async () => { checked = true; return true; }), /backup_generation_unknown/);
  assert.equal(checked, false);
});
