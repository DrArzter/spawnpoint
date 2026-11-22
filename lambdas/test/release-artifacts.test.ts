import assert from "node:assert/strict";
import test from "node:test";

import { clientPackKey, manifestClientAddons, manifestClientMods, releaseArtifactPrefix, releaseModKey, releaseModLocation, releasePackKey } from "../src/control-plane/release-artifacts.ts";

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

test("a client addon of a modpack release is found in client-mods; a both addon with the server's (ADR-0077)", () => {
  const backpacks = { file: "sophisticatedbackpacks-1.20.1-3.23.4.5.110.jar", sha256: "e".repeat(64), bytes: 986101 };
  const minimap = { file: "minimap.jar", sha256: "f".repeat(64), bytes: 4 };
  const modpack = {
    server: { mods: [shared, backpacks] },
    client: { kind: "curseforge-modpack", file: "client.zip", addons: [{ ...backpacks, side: "both" }, { ...minimap, side: "client" }, { ...playersOnly, side: "elsewhere" }] },
  };
  assert.deepEqual(manifestClientAddons(modpack), [{ ...backpacks, side: "both" }, { ...minimap, side: "client" }]);
  assert.deepEqual(releaseModLocation(modpack, backpacks.sha256), { file: backpacks.file, store: "mods" });
  assert.deepEqual(releaseModLocation(modpack, minimap.sha256), { file: "minimap.jar", store: "client-mods" });
  assert.equal(releaseModLocation(modpack, playersOnly.sha256), null);
  assert.deepEqual(manifestClientAddons(sides), []);
  assert.deepEqual(manifestClientAddons({ client: { kind: "mod-set", addons: [{ ...minimap, side: "client" }] } }), []);
});

test("a release's packs sit beside its manifest, one zip each", () => {
  assert.equal(releasePackKey("minecraft", "main", "1.1", "client"), clientPackKey("minecraft", "main", "1.1"));
  assert.equal(releasePackKey("minecraft", "main", "1.1", "server"), "releases/minecraft/main/1.1/server.zip");
  assert.equal(releasePackKey("minecraft", "main", "1.1", "full"), "releases/minecraft/main/1.1/full.zip");
});
