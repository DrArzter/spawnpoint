import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import { configPathValid, insideWorldData } from "../src/control-plane/world-config.ts";
import type { ConfigFileStore, WorldConfigFiles } from "../src/control-plane/world-config.ts";
import { findGameModule } from "../src/control-plane/game-modules.ts";
import type { ConfigFilesUpdate } from "../src/control-plane/world-records.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { worldConfigFeature } from "../src/handlers/api/world-config.ts";

// A world's own config files (ADR-0093), against in-memory ports.

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };
const sha = (text: string) => createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
const rules = findGameModule("minecraft")!.configFileRules!;

const RELEASE_TEXT = "max_claims = 10\n";
const release = { path: "config/claims.toml", sha256: sha(RELEASE_TEXT), bytes: RELEASE_TEXT.length };

function world(configFiles?: WorldConfigFiles): WorldRecord {
  return {
    worldId: "world-a", gameId: "minecraft", displayName: "World A", status: "active", placement: "fleet", connectivity: "raw", auth: "game",
    preset: { id: "preset-a", repository: "r", commit: "c".repeat(40), profileDigest: "d".repeat(64) },
    currentGeneration: { id: `gen-${"a".repeat(32)}` } as WorldRecord["currentGeneration"],
    previousGenerations: [],
    ...(configFiles === undefined ? {} : { configFiles }),
  };
}

function fakes(initial: WorldConfigFiles = {}) {
  let files: WorldConfigFiles = initial;
  const stored = new Map<string, Uint8Array>();
  const store: ConfigFileStore = {
    putWorldFile: async (_world, digest, bytes) => { stored.set(digest, bytes); },
    readWorldFile: async (_world, digest) => stored.get(digest) ?? null,
    readReleaseFile: async (_release, file) => file.path === release.path ? new TextEncoder().encode(RELEASE_TEXT) : null,
  };
  const feature = worldConfigFeature({
    sources: {
      readReleasePointer: async () => ({ state: "available", generationId: null, desiredRelease: "2.0", activeRelease: "1.0" }),
      readReleaseManifest: async () => ({
        storage: { layout: "objects-v1" },
        server: { overrides: [release, { path: "config/mod/data/state.json", sha256: sha("{}"), bytes: 2 }, { path: "config/mod.jar", sha256: sha("x"), bytes: 1 }], world_data: ["config/mod/data"] },
      }),
    },
    worlds: {
      read: async () => world(files),
      updateConfigFiles: async (_game: string, _world: string, update: ConfigFilesUpdate) => {
        const next = update(files);
        if ("refused" in next) return next.refused;
        files = next.files;
        return "updated";
      },
    },
    files: store,
    now: () => new Date("2026-11-24T12:00:00.000Z"),
  });
  return { feature, stored, current: () => files };
}

const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test("a path stays inside the game's config roots, with no hidden or parent segments", () => {
  assert.ok(configPathValid("config/claims.toml", rules));
  for (const path of ["claims.toml", "world/level.dat", "config/../ops.json", "config/.hidden", "config//a.toml", "/config/a.toml", 3]) {
    assert.equal(configPathValid(path, rules), false, String(path));
  }
  assert.ok(insideWorldData("config/mod/data/state.json", ["config/mod/data"]));
  assert.equal(insideWorldData("config/mod/datafile.json", ["config/mod/data"]), false);
});

test("the list shows the release's files, which of them can be edited, and the world's edits", async () => {
  const { feature } = fakes();
  const body = json(await feature.listConfigFiles("minecraft", "world-a")) as { release: string; files: { path: string; editable: boolean; source: string }[] };
  assert.equal(body.release, "2.0");
  assert.deepEqual(body.files.map((file) => [file.path, file.editable, file.source]), [
    ["config/claims.toml", true, "release"],
    ["config/mod.jar", false, "release"],
    ["config/mod/data/state.json", false, "release"],
  ]);
});

test("a save stores the text, names who made it, and the next read returns it", async () => {
  const { feature, stored, current } = fakes();
  const text = "max_claims = 50\n";
  const saved = await feature.saveConfigFile(owner, "minecraft", "world-a", JSON.stringify({ path: release.path, text, expectedSha256: release.sha256 }));
  assert.equal(saved.statusCode, 200);
  assert.equal(stored.get(sha(text)) !== undefined, true);
  assert.deepEqual(current()[release.path], { sha256: sha(text), bytes: text.length, baseSha256: release.sha256, updatedAt: "2026-11-24T12:00:00.000Z", updatedBy: { identityId: "identity-1", displayName: "Owner" } });
  const read = json(await feature.readConfigFile("minecraft", "world-a", release.path));
  assert.deepEqual([read.text, read.source, read.sha256], [text, "world", sha(text)]);
});

test("a save from a version that is no longer current is refused", async () => {
  const { feature, current } = fakes();
  const stale = await feature.saveConfigFile(owner, "minecraft", "world-a", JSON.stringify({ path: release.path, text: "x = 1\n", expectedSha256: sha("old") }));
  assert.deepEqual([stale.statusCode, json(stale).error], [409, "config_file_changed"]);
  assert.deepEqual(current(), {});
});

test("saving the release's own text takes the world's edit away", async () => {
  const edit = { sha256: sha("max_claims = 50\n"), bytes: 16, baseSha256: release.sha256, updatedAt: "2026-11-23T00:00:00.000Z", updatedBy: { identityId: "identity-1", displayName: "Owner" } };
  const { feature, current } = fakes({ [release.path]: edit });
  const saved = await feature.saveConfigFile(owner, "minecraft", "world-a", JSON.stringify({ path: release.path, text: RELEASE_TEXT, expectedSha256: edit.sha256 }));
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(current(), {});
});

test("world data, a file that is not text, and a path outside the roots are refused", async () => {
  const { feature } = fakes();
  const save = (path: string, text: string) => feature.saveConfigFile(owner, "minecraft", "world-a", JSON.stringify({ path, text, expectedSha256: null }));
  assert.deepEqual(json(await save("config/mod/data/state.json", "{}")).error, "config_file_not_editable");
  assert.deepEqual(json(await save("config/mod.jar", "x")).error, "config_file_not_editable");
  assert.deepEqual(json(await save("ops.json", "[]")).error, "invalid_config_path");
  assert.deepEqual(json(await save("config/new.toml", "a\u0000b")).error, "config_file_not_text");
  assert.equal((await save("config/new.toml", "x".repeat(rules.maxBytes + 1))).statusCode, 413);
});

test("a reset removes the edit only when it is the version the panel showed", async () => {
  const edit = { sha256: sha("max_claims = 50\n"), bytes: 16, baseSha256: sha("an older release"), updatedAt: "2026-11-23T00:00:00.000Z", updatedBy: { identityId: "identity-1", displayName: "Owner" } };
  const { feature, current } = fakes({ [release.path]: edit });
  const listed = json(await feature.listConfigFiles("minecraft", "world-a")) as { files: { path: string; releaseChanged: boolean }[] };
  assert.equal(listed.files.find((file) => file.path === release.path)?.releaseChanged, true, "the release changed the file since the edit");
  assert.equal((await feature.resetConfigFile(owner, "minecraft", "world-a", release.path, sha("other"))).statusCode, 409);
  assert.equal((await feature.resetConfigFile(owner, "minecraft", "world-a", release.path, edit.sha256)).statusCode, 200);
  assert.deepEqual(current(), {});
  assert.equal((await feature.resetConfigFile(owner, "minecraft", "world-a", release.path, edit.sha256)).statusCode, 404);
});

test("a game with no config rules has no config files", async () => {
  const { feature } = fakes();
  assert.deepEqual(json(await feature.listConfigFiles("factorio", "world-a")).error, "game_has_no_config_files");
});
