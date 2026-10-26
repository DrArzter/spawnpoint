import assert from "node:assert/strict";
import test from "node:test";
import { awsControlPlaneSources } from "../src/control-plane/aws.ts";
import { buildRelease, releaseManifest } from "../src/handlers/api/releases.ts";

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
