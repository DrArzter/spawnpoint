import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/access/domain.ts";
import type { WorldRecord } from "../src/control-plane/world-registry.ts";
import { releasesFeature, type ReleasesDependencies } from "../src/handlers/api/releases.ts";

// The releases against their ports: links come from the links port, builds and
// retirements from theirs, and nothing reaches a cloud API.

const owner: Identity = { id: "identity-1", displayName: "Owner", roleId: "owner", directGrants: [] };

function fakes(overrides: Partial<ReleasesDependencies["sources"]> = {}) {
  const packs: string[] = [];
  const retired: unknown[] = [];
  const feature = releasesFeature({
    sources: {
      readReleaseManifest: async () => ({ release: "1.2", server: { mods: [] } }),
      readReleasePlan: async () => null,
      listWorldRecords: async () => [{ gameId: "game-a", worldId: "world-a", preset: { id: "preset-a" }, currentGeneration: { id: "gen-1" } } as unknown as WorldRecord],
      readReleasePointer: async () => ({ state: "available", generationId: "gen-1", desiredRelease: "1.2", activeRelease: "1.1" }),
      ...overrides,
    },
    links: {
      pack: async (gameId, presetId, release, pack, expiresIn) => { packs.push(`${gameId}/${presetId}/${release}/${pack}/${expiresIn}`); return "https://signed.example.test/pack"; },
      mod: async () => "https://signed.example.test/mod",
    },
    startBuild: async () => ({ release: "1.3", attempt: 1 }),
    retirement: { request: async (request) => { retired.push(request); } },
  });
  return { feature, packs, retired };
}

test("a world's pack is the client pack of the release it runs, linked for an hour", async () => {
  const { feature, packs } = fakes();
  const response = await feature.packDownload("game-a", "world-a");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { release: "1.1", url: "https://signed.example.test/pack", expiresIn: 3600 });
  assert.deepEqual(packs, ["game-a/preset-a/1.1/client/3600"]);
});

test("a world with no selected release has no pack", async () => {
  const { feature, packs } = fakes({ readReleasePointer: async () => ({ state: "unconfigured", generationId: null, desiredRelease: null, activeRelease: null }) });
  assert.equal((await feature.packDownload("game-a", "world-a")).statusCode, 409);
  assert.deepEqual(packs, []);
});

test("a retirement goes to the retirement port only with its exact confirmation", async () => {
  const { feature, retired } = fakes();
  const wrong = await feature.requestReleaseRetirement(owner, "game-a", "preset-a", "1.2", JSON.stringify({ confirmation: "yes" }));
  assert.equal(wrong.statusCode, 400);
  assert.deepEqual(retired, []);
});
