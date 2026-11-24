import assert from "node:assert/strict";
import test from "node:test";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

process.env.AWS_REGION ??= "eu-central-1";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.RELEASE_BUCKET = "releases";

const { awsControlPlaneSources } = await import("../src/control-plane/aws.ts");
const { deployedReleases } = await import("../src/handlers/api/releases-wiring.ts");
const { s3ReleaseLinks } = await import("../src/control-plane/s3-release-links.ts");
const { releaseModDownload } = deployedReleases;
const links = s3ReleaseLinks(new S3Client({}), () => process.env.RELEASE_BUCKET!, (gameId, presetId, release) =>
  awsControlPlaneSources.readReleaseManifest?.(gameId, presetId, release) ?? Promise.resolve(null));
const packDownloadUrl = (gameId: string, presetId: string, release: string) => links.pack(gameId, presetId, release, "client", 3600);
const releasePackUrl = links.pack;
const { packUrl } = await import("../src/bot/services/aws.ts");
const { digestOfObjectKey, manifestPackObject, manifestUsesObjects, objectKey, releasePackStorageKey } = await import("../src/control-plane/release-objects.ts");

const CLIENT = "ab".repeat(32);
const SERVER = "cd".repeat(32);
const MOD = "ef".repeat(32);
const objects = {
  schema_version: 1,
  storage: { layout: "objects-v1" },
  server: { mods: [{ file: "lib mod [1.0].jar", sha256: MOD, bytes: 5 }] },
  client: { kind: "mod-set", file: "client.zip", sha256: CLIENT, bytes: 9, mods: [] },
  packs: { server: { sha256: SERVER, bytes: 7 } },
};
const legacy = { schema_version: 1, server: { mods: [{ file: "lib.jar", sha256: MOD, bytes: 5 }] }, client: { sha256: CLIENT, bytes: 9 } };

function signed(url: string | null) {
  assert.notEqual(url, null);
  const parsed = new URL(url!);
  return { path: parsed.pathname, disposition: parsed.searchParams.get("response-content-disposition") };
}

function storage(t: import("node:test").TestContext, manifest: unknown) {
  const heads: string[] = [];
  t.mock.method(awsControlPlaneSources as Required<typeof awsControlPlaneSources>, "readReleaseManifest", async () => manifest);
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof HeadObjectCommand) { heads.push(command.input.Key!); return {}; }
    if (command instanceof GetObjectCommand) {
      return { Body: { transformToString: async () => JSON.stringify(manifest) } };
    }
    throw new Error("unexpected command");
  });
  return heads;
}

test("object keys are the digest, with no name and no extension", () => {
  assert.equal(objectKey(CLIENT), `objects/sha256/ab/${CLIENT}`);
  assert.equal(digestOfObjectKey(objectKey(CLIENT)), CLIENT);
  assert.equal(digestOfObjectKey(`objects/sha256/cd/${CLIENT}`), null);
  assert.throws(() => objectKey("../x"), /invalid_digest/);
});

test("a manifest is legacy unless it says objects-v1", () => {
  assert.equal(manifestUsesObjects(objects), true);
  assert.equal(manifestUsesObjects(legacy), false);
  assert.equal(manifestUsesObjects({ storage: { layout: "objects-v2" } }), false);
  assert.deepEqual(manifestPackObject(objects, "server"), { sha256: SERVER, bytes: 7 });
  assert.equal(manifestPackObject(objects, "full"), null);
});

test("an objects-v1 client pack is presigned by digest with the attachment name", async (t) => {
  const heads = storage(t, objects);
  const link = signed(await packDownloadUrl("minecraft", "industrial", "1.2"));
  assert.equal(link.path, `/objects/sha256/ab/${CLIENT}`);
  assert.equal(link.disposition, "attachment; filename*=UTF-8''industrial-1.2-client.zip");
  assert.deepEqual(heads, [`objects/sha256/ab/${CLIENT}`]);
});

test("a legacy client pack keeps its own key and now has an attachment name too", async (t) => {
  storage(t, legacy);
  const link = signed(await packDownloadUrl("minecraft", "industrial", "1.2"));
  assert.equal(link.path, "/releases/minecraft/industrial/1.2/client.zip");
  assert.equal(link.disposition, "attachment; filename*=UTF-8''industrial-1.2-client.zip");
});

test("a pack an objects-v1 manifest does not name is not offered", async (t) => {
  const heads = storage(t, objects);
  assert.equal(await releasePackUrl("minecraft", "industrial", "1.2", "full", 900), null);
  assert.deepEqual(heads, []);
  const link = signed(await releasePackUrl("minecraft", "industrial", "1.2", "server", 900));
  assert.equal(link.path, `/objects/sha256/cd/${SERVER}`);
  assert.equal(link.disposition, "attachment; filename*=UTF-8''industrial-1.2-server.zip");
});

test("a missing object is a normal answer, not an error", async (t) => {
  storage(t, objects);
  t.mock.method(S3Client.prototype, "send", async () => { throw Object.assign(new Error("missing"), { name: "NotFound" }); });
  assert.equal(await packDownloadUrl("minecraft", "industrial", "1.2"), null);
});

test("one mod of an objects-v1 release is presigned by digest and named by its manifest entry", async (t) => {
  storage(t, objects);
  const result = await releaseModDownload("minecraft", "industrial", "1.2", MOD);
  assert.equal(result.statusCode, 200);
  const link = signed(JSON.parse(result.body).url);
  assert.equal(link.path, `/objects/sha256/ef/${MOD}`);
  assert.equal(link.disposition, `attachment; filename*=UTF-8''${encodeURIComponent("lib mod [1.0].jar")}`);
});

test("a digest the manifest does not name is unknown, whatever object exists", async (t) => {
  storage(t, objects);
  assert.equal((await releaseModDownload("minecraft", "industrial", "1.2", "01".repeat(32))).statusCode, 404);
});

test("one mod of a legacy release keeps its per-release key", async (t) => {
  storage(t, legacy);
  const link = signed(JSON.parse((await releaseModDownload("minecraft", "industrial", "1.2", MOD)).body).url);
  assert.equal(link.path, "/releases/minecraft/industrial/1.2/mods/lib.jar");
});

test("the bot serves the same object, with the same attachment name", async (t) => {
  const heads = storage(t, objects);
  const link = signed(await packUrl("minecraft", "industrial", "1.2"));
  assert.equal(link.path, `/objects/sha256/ab/${CLIENT}`);
  assert.equal(link.disposition, "attachment; filename*=UTF-8''industrial-1.2-client.zip");
  assert.deepEqual(heads, [`objects/sha256/ab/${CLIENT}`]);
});

test("the bot keeps the legacy key when the manifest has no layout, or no manifest is readable", async (t) => {
  storage(t, legacy);
  assert.equal(signed(await packUrl("minecraft", "industrial", "1.2")).path, "/releases/minecraft/industrial/1.2/client.zip");
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof GetObjectCommand) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return {};
  });
  assert.equal(signed(await packUrl("minecraft", "industrial", "1.2")).path, "/releases/minecraft/industrial/1.2/client.zip");
});

test("both layouts give the same pack key through the shared helper", () => {
  assert.equal(releasePackStorageKey(legacy, "minecraft", "industrial", "1.2", "client"), "releases/minecraft/industrial/1.2/client.zip");
  assert.equal(releasePackStorageKey(objects, "minecraft", "industrial", "1.2", "client"), `objects/sha256/ab/${CLIENT}`);
});
