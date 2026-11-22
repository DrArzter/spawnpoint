import assert from "node:assert/strict";
import test from "node:test";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { buildRelease, releaseManifest, releasePackDownload } from "../src/handlers/api/releases.ts";

const identity = { id: "operator", displayName: "Operator", roleId: "operator", directGrants: [] } as const;
const sources = awsControlPlaneSources as Required<Pick<typeof awsControlPlaneSources, "readReleaseManifest">>;

test("release manifests retain the client-facing metadata and exact source revision", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.2", minecraft_version: "1.20.1", loader: { type: "fabric", version: "0.19.3" },
    source_profile: { id: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40) },
    server: { mods: [{ file: "example.jar", sha256: "b".repeat(64), bytes: 123 }] },
  }));
  const result = await releaseManifest("minecraft", "industrial", "1.2");
  assert.equal(result.statusCode, 200);
  const data = JSON.parse(result.body);
  assert.deepEqual(data.loader, { type: "fabric", version: "0.19.3" });
  assert.deepEqual(data.source, { presetId: "industrial", repository: "https://github.com/example/config", commit: "a".repeat(40) });
  assert.deepEqual(data.mods, [{ file: "example.jar", sha256: "b".repeat(64), bytes: 123 }]);
  // Players install the server's set: no separate one to show.
  assert.equal(data.clientMods, null);
});

test("a mod's source is answered when the manifest names a known one, and left out otherwise", async (t) => {
  const mod = (file: string, source?: unknown) => ({ file, sha256: file.padEnd(64, "0"), bytes: 1, ...(source === undefined ? {} : { source }) });
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.5",
    server: { mods: [mod("a.jar", "curseforge"), mod("b.jar", "modrinth"), mod("c.jar", "github"), mod("d.jar", "elsewhere"), mod("e.jar")] },
    client: { kind: "mod-set", mods: [mod("a.jar", "curseforge"), mod("f.jar", "modrinth")] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "industrial", "1.5")).body);
  assert.deepEqual(data.mods.map((item: { source?: string }) => item.source ?? null), ["curseforge", "modrinth", "github", null, null]);
  assert.equal("source" in data.mods[4], false);
  assert.deepEqual(data.clientMods.map((item: { source?: string }) => item.source ?? null), ["curseforge", "modrinth"]);
});

test("a release with side lists answers the players' set beside the server's (ADR-0069)", async (t) => {
  const shared = { file: "shared.jar", sha256: "a".repeat(64), bytes: 1 };
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.3", server: { mods: [shared, { file: "spark.jar", sha256: "b".repeat(64), bytes: 2 }] },
    client: { kind: "mod-set", mods: [shared, { file: "minimap.jar", sha256: "c".repeat(64), bytes: 3 }] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "industrial", "1.3")).body);
  assert.deepEqual(data.mods.map((mod: { file: string }) => mod.file), ["shared.jar", "spark.jar"]);
  assert.deepEqual(data.clientMods.map((mod: { file: string }) => mod.file), ["shared.jar", "minimap.jar"]);
});

test("a modpack release with addons answers each addon and its side; mod_index stays out (ADR-0077)", async (t) => {
  const backpacks = { file: "sophisticatedbackpacks-1.20.1-3.23.4.5.110.jar", sha256: "a".repeat(64), bytes: 986101 };
  t.mock.method(sources, "readReleaseManifest", async () => ({
    release: "1.4", server: { mods: [{ file: "fabric-api.jar", sha256: "b".repeat(64), bytes: 2 }, backpacks] },
    client: { kind: "curseforge-modpack", file: "client.zip", sha256: "c".repeat(64), bytes: 3, addons: [{ ...backpacks, side: "both" }] },
    mod_index: { ["a".repeat(64)]: ["sophisticatedbackpacks"] },
  }));
  const data = JSON.parse((await releaseManifest("minecraft", "prominence", "1.4")).body);
  assert.deepEqual(data.addons, [{ ...backpacks, side: "both" }]);
  assert.equal(data.clientMods, null);
  assert.equal("mod_index" in data, false);
});

test("a release without addons answers an empty list", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({ release: "1.0", server: { mods: [] } }));
  assert.deepEqual(JSON.parse((await releaseManifest("minecraft", "prominence", "1.0")).body).addons, []);
});

test("manifest text fields cannot stringify objects or arrays into misleading metadata", async (t) => {
  t.mock.method(sources, "readReleaseManifest", async () => ({
    loader: { type: {}, version: [] }, source_profile: { id: {}, repository: [], commit: null },
    server: { mods: [{ file: {}, sha256: [], bytes: 1 }] },
  }));
  const result = await releaseManifest("minecraft", "industrial", "1.2");
  const data = JSON.parse(result.body);
  assert.deepEqual(data.loader, { type: "", version: "" });
  assert.deepEqual(data.source, { presetId: "", repository: "", commit: "" });
  assert.deepEqual(data.mods, [{ file: "", sha256: "", bytes: 1 }]);
  assert.ok(!result.body.includes("[object Object]"));
});

test("a missing manifest stays a 404 and invalid references never reach storage", async (t) => {
  const read = t.mock.method(sources, "readReleaseManifest", async () => null);
  assert.equal((await releaseManifest("minecraft", "industrial", "../1.2")).statusCode, 400);
  assert.equal(read.mock.callCount(), 0);
  const missing = await releaseManifest("minecraft", "industrial", "1.2");
  assert.deepEqual(JSON.parse(missing.body), { error: "unknown_release" });
  assert.equal(missing.statusCode, 404);
});

test("build input rejects malformed JSON separately from an invalid pinned-build request", async () => {
  const malformed = await buildRelease(identity, "minecraft", "industrial", "{");
  assert.deepEqual(JSON.parse(malformed.body), { error: "invalid_json" });
  for (const body of ["null", "[]", "{}", JSON.stringify({ profileDigest: "a".repeat(64), retryRelease: "../1.2" })]) {
    const result = await buildRelease(identity, "minecraft", "industrial", body);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_build_request" });
  }
});

test("a release pack is one of client, server or full, and nothing reaches storage otherwise", async () => {
  for (const [pack, version] of [["everything", "1.2"], ["../client", "1.2"], ["server", "latest"]] as const) {
    const result = await releasePackDownload("minecraft", "industrial", version, pack);
    assert.equal(result.statusCode, 400);
    assert.deepEqual(JSON.parse(result.body), { error: "invalid_release_reference" });
  }
});
