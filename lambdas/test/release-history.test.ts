import assert from "node:assert/strict";
import test from "node:test";

import { catalogWithPresets, gameCatalog } from "../src/control-plane/catalog.ts";
import { parsePresetCatalog, usableByExistingWorld, usableByNewWipe } from "../src/control-plane/preset-catalog.ts";
import { planPromotion, type PromotionFacts } from "../src/control-plane/promotion.ts";
import { newWorldRecord, regenerateWorldRecord, type WorldRecord } from "../src/control-plane/world-registry.ts";

const OLD_DIGEST = "1".repeat(64);
const NEW_DIGEST = "2".repeat(64);
const COMMIT = "a".repeat(40);
const revision = (profile_digest: string | null) => ({ profile_digest, source_commit: COMMIT });

function catalog(entry: Record<string, unknown>) {
  return {
    schema_version: 2,
    game: "minecraft",
    source: { repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: COMMIT },
    presets: [{ id: "prominence", display_name: "Prominence II", profile_digest: NEW_DIGEST, source_commit: COMMIT, ...entry }],
  };
}

// The live case: the digest changed, the build of the new revision failed, and
// the release that the world runs on is still published.
const unbuilt = catalog({
  build_status: "unbuilt", releases: ["39127124115.1"], latest_release: "39127124115.1",
  built_from: { "39127124115.1": revision(OLD_DIGEST) },
});

test("a release built from an older digest is marked, and the entry keeps its own build state", () => {
  const [preset] = parsePresetCatalog(unbuilt, "minecraft")!;
  assert.equal(preset!.buildStatus, "unbuilt");
  assert.equal(preset!.latestRelease, "39127124115.1");
  assert.deepEqual(preset!.releases, ["39127124115.1"]);
  assert.deepEqual(preset!.olderReleases, ["39127124115.1"]);
});

test("a release built from the current digest, and a legacy entry without built_from, are current", () => {
  const ready = catalog({
    build_status: "ready", releases: ["1.0", "2.0"], latest_release: "2.0",
    built_from: { "1.0": revision(OLD_DIGEST), "2.0": revision(NEW_DIGEST) },
  });
  assert.deepEqual(parsePresetCatalog(ready, "minecraft")![0]!.olderReleases, ["1.0"]);
  const legacy = catalog({ build_status: "ready", releases: ["1.0"], latest_release: "1.0" });
  assert.deepEqual(parsePresetCatalog(legacy, "minecraft")![0]!.olderReleases, []);
});

test("a release recovered without its revision is older", () => {
  const recovered = catalog({ build_status: "unbuilt", releases: ["7.1"], latest_release: "7.1", built_from: { "7.1": revision(null) } });
  assert.deepEqual(parsePresetCatalog(recovered, "minecraft")![0]!.olderReleases, ["7.1"]);
});

test("a malformed built_from refuses the catalog", () => {
  const base = { build_status: "unbuilt", releases: ["1.0"], latest_release: "1.0" };
  for (const built_from of [[], "x", { "2.0": revision(OLD_DIGEST) }, { "1.0": { profile_digest: "short", source_commit: COMMIT } }, { "1.0": { profile_digest: OLD_DIGEST, source_commit: "main" } }, { "1.0": null }]) {
    assert.equal(parsePresetCatalog(catalog({ ...base, built_from }), "minecraft"), null);
  }
});

test("an existing world may use an older-revision release; a new world or wipe may not", () => {
  const [preset] = parsePresetCatalog(unbuilt, "minecraft")!;
  assert.equal(usableByExistingWorld(preset!, "39127124115.1"), true);
  assert.equal(usableByNewWipe(preset!, "39127124115.1"), false);
  assert.equal(usableByExistingWorld(preset!, "1.0"), false);
});

test("a current release is usable by an existing world only while its revision is ready", () => {
  const building = parsePresetCatalog(catalog({ build_status: "building", releases: ["1.0"], latest_release: "1.0" }), "minecraft")![0]!;
  assert.equal(usableByExistingWorld(building, "1.0"), false);
  assert.equal(usableByNewWipe(building, "1.0"), true);
});

const GENERATION = `gen-${"c".repeat(32)}`;
const record: WorldRecord = {
  gameId: "minecraft", worldId: "prominence-a1b2c3d4", displayName: "Prominence", status: "active", placement: "fleet",
  connectivity: "raw", auth: "game",
  preset: { id: "prominence", repository: "https://github.com/DrArzter/my-docker-minecraft-server-config", commit: COMMIT, profileDigest: OLD_DIGEST },
  currentGeneration: { id: GENERATION, release: "100.1", createdAt: "2026-10-18T00:00:00Z", source: { kind: "preset" } },
  previousGenerations: [],
};

function promotion(values: Partial<PromotionFacts>) {
  const plan = planPromotion({
    gameId: "minecraft", release: "200.1", record,
    preset: parsePresetCatalog(catalog({
      build_status: "failed", releases: ["100.1", "200.1"], latest_release: "200.1",
      built_from: { "100.1": revision(OLD_DIGEST), "200.1": revision(OLD_DIGEST) },
    }), "minecraft")![0]!,
    pointer: { state: "available", generationId: GENERATION, desiredRelease: "100.1", activeRelease: "100.1" },
    session: null, blockingOperations: 0, launchEnabled: true, configuredHostId: "i-0123456789abcdef0",
    ...values,
  });
  return plan.kind === "reject" ? `${plan.status} ${plan.error}` : plan.kind;
}

test("a fleet world is promoted to an older-revision release while the new revision is not built", () => {
  assert.equal(promotion({}), "execute");
  assert.equal(promotion({ release: "300.1" }), "409 release_not_available");
});

test("a new world and a new wipe refuse an older-revision release", () => {
  const [preset] = parsePresetCatalog(unbuilt, "minecraft")!;
  const identity = { worldId: "minecraft-x-a1b2c3d4", displayName: "X", release: "39127124115.1" };
  assert.throws(() => newWorldRecord(preset!, identity, "12345678-1234-1234-1234-1234567890ab", "2026-11-22T00:00:00.000Z"), /release_outdated/);
  const ready = { ...preset!, buildStatus: "ready" as const };
  assert.throws(() => regenerateWorldRecord(record, ready, "39127124115.1", "12345678-1234-1234-1234-1234567890ab", "2026-11-22T00:00:00.000Z"), /release_outdated/);
});

test("the catalog carries the older releases to the panel", () => {
  const presets = parsePresetCatalog(unbuilt, "minecraft")!;
  const game = catalogWithPresets(presets, gameCatalog).find((item) => item.id === "minecraft")!;
  assert.deepEqual(game.presets?.[0]?.olderReleases, ["39127124115.1"]);
});
