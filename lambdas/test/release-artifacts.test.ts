import assert from "node:assert/strict";
import test from "node:test";

import { clientPackKey, releaseArtifactPrefix } from "../src/control-plane/release-artifacts.ts";

test("release artifacts are scoped by game, preset and version", () => {
  assert.equal(releaseArtifactPrefix("minecraft", "main", "1.1"), "releases/minecraft/main/1.1");
  assert.equal(clientPackKey("factorio", "space-age", "42.7"), "releases/factorio/space-age/42.7/client.zip");
});

test("artifact paths reject identities that could escape their namespace", () => {
  assert.throws(() => clientPackKey("minecraft", "../main", "1.1"), /invalid_preset_id/);
  assert.throws(() => clientPackKey("minecraft", "main", "latest"), /invalid_release/);
});
