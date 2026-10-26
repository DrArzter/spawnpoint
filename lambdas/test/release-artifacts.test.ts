import assert from "node:assert/strict";
import test from "node:test";

import { clientPackKey, manifestClientMods, releaseArtifactPrefix, releaseModKey, releaseModLocation } from "../src/control-plane/release-artifacts.ts";

test("release artifacts are scoped by game, preset and version", () => {
  assert.equal(releaseArtifactPrefix("minecraft", "main", "1.1"), "releases/minecraft/main/1.1");
  assert.equal(clientPackKey("factorio", "space-age", "42.7"), "releases/factorio/space-age/42.7/client.zip");
});

test("artifact paths reject identities that could escape their namespace", () => {
  assert.throws(() => clientPackKey("minecraft", "../main", "1.1"), /invalid_preset_id/);
  assert.throws(() => clientPackKey("minecraft", "main", "latest"), /invalid_release/);
});

const shared = { file: "shared.jar", sha256: "a".repeat(64), bytes: 1 };
const serverOnly = { file: "spark.jar", sha256: "b".repeat(64), bytes: 2 };
const playersOnly = { file: "minimap.jar", sha256: "c".repeat(64), bytes: 3 };
const sides = { server: { mods: [shared, serverOnly] }, client: { kind: "mod-set", mods: [shared, playersOnly] } };

test("a mod is found by its digest in the set that stores it (ADR-0069)", () => {
  assert.deepEqual(releaseModLocation(sides, shared.sha256), { file: "shared.jar", store: "mods" });
  assert.deepEqual(releaseModLocation(sides, serverOnly.sha256), { file: "spark.jar", store: "mods" });
  assert.deepEqual(releaseModLocation(sides, playersOnly.sha256), { file: "minimap.jar", store: "client-mods" });
  assert.equal(releaseModLocation(sides, "d".repeat(64)), null);
  assert.equal(releaseModKey("minecraft", "main", "1.1", "minimap.jar", "client-mods"), "releases/minecraft/main/1.1/client-mods/minimap.jar");
});

test("the players' set exists only as a mod set; a modpack's client archive is not one", () => {
  assert.deepEqual(manifestClientMods(sides), [shared, playersOnly]);
  assert.equal(manifestClientMods({ server: { mods: [shared] } }), null);
  assert.equal(manifestClientMods({ client: { kind: "curseforge-modpack", file: "client.zip" } }), null);
  assert.equal(releaseModLocation({ client: { kind: "curseforge-modpack", mods: [playersOnly] } }, playersOnly.sha256), null);
});
