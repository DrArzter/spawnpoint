import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";

process.env.ACCESS_TABLE_NAME = "access-api-test";
process.env.AVATAR_BUCKET = "spawnpoint-avatars-test";
process.env.AWS_REGION = "eu-central-1";
process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
process.env.AWS_SECRET_ACCESS_KEY = "secret";
const { document } = await import("../src/handlers/api/access-store.ts");
const { avatarLink, copyProviderAvatar, removeAvatar, uploadAvatar } = await import("../src/handlers/api/avatars.ts");

// ADR-0084: an identity owns its avatar.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
const ada = { id: "id-ada", displayName: "Ada", roleId: "viewer", directGrants: [] as const };

function aws(t: TestContext, options: { conditionFails?: boolean; stored?: string[] } = {}) {
  const objects = new Set(options.stored ?? []);
  const writes: Record<string, unknown>[] = [];
  t.mock.method(S3Client.prototype, "send", async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const input = command.input;
    if (command.constructor.name === "PutObjectCommand") objects.add(String(input.Key));
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...objects].filter((key) => key.startsWith(String(input.Prefix))).map((Key) => ({ Key })) };
    if (command.constructor.name === "DeleteObjectsCommand") for (const object of (input.Delete as { Objects: { Key: string }[] }).Objects) objects.delete(object.Key);
    return {};
  });
  t.mock.method(document, "send", async (command: { input: Record<string, unknown> }) => {
    if (options.conditionFails) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
    writes.push(command.input);
    return {};
  });
  return { objects, writes };
}

function web(t: TestContext, answers: Record<string, { status: number; location?: string; body?: Uint8Array }>) {
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    asked.push(url);
    const answer = answers[url] ?? { status: 404 };
    return new Response(answer.body === undefined ? null : Buffer.from(answer.body), { status: answer.status, headers: answer.location ? { location: answer.location } : {} });
  });
  return asked;
}

test("a provider photo is copied once, following a redirect only to a provider's picture host", async (t) => {
  const { objects, writes } = aws(t);
  web(t, {
    "https://t.me/i/userpic/320/ada.jpg": { status: 302, location: "https://cdn4.telesco.pe/file/ada.jpg" },
    "https://cdn4.telesco.pe/file/ada.jpg": { status: 200, body: JPEG },
  });
  const key = await copyProviderAvatar(ada, { url: "https://t.me/i/userpic/320/ada.jpg", provider: "telegram" });
  assert.match(String(key), /^id-ada\/[0-9a-f]{64}\.jpg$/);
  assert.deepEqual([...objects], [key]);
  assert.match(String(writes[0]?.ConditionExpression), /attribute_not_exists\(avatar_key\) AND attribute_not_exists\(avatar_removed\)/, "never replaces an avatar");
  assert.equal((writes[0]?.ExpressionAttributeValues as Record<string, unknown>)[":source"], "telegram");
});

test("a photo is not copied from elsewhere, nor when it is not an image, nor over an existing or removed avatar", async (t) => {
  const { objects } = aws(t);
  const asked = web(t, {
    "https://t.me/i/userpic/320/a.jpg": { status: 302, location: "https://evil.example/a.jpg" },
    "https://t.me/i/userpic/320/svg": { status: 200, body: new TextEncoder().encode("<svg/>") },
  });
  assert.equal(await copyProviderAvatar(ada, { url: "https://t.me/i/userpic/320/a.jpg", provider: "telegram" }), null);
  assert.equal(asked.includes("https://evil.example/a.jpg"), false, "the redirect is not followed");
  assert.equal(await copyProviderAvatar(ada, { url: "https://t.me/i/userpic/320/svg", provider: "telegram" }), null);
  assert.equal(await copyProviderAvatar({ ...ada, avatarKey: "id-ada/x.jpg" }, { url: "https://t.me/i/userpic/320/svg", provider: "telegram" }), null);
  assert.equal(await copyProviderAvatar({ ...ada, avatarRemoved: true }, { url: "https://t.me/i/userpic/320/svg", provider: "telegram" }), null);
  assert.equal(objects.size, 0);
});

test("a copy that loses to another sign-in leaves the other one's avatar", async (t) => {
  aws(t, { conditionFails: true });
  web(t, { "https://lh3.googleusercontent.com/a/ada": { status: 200, body: PNG } });
  assert.equal(await copyProviderAvatar(ada, { url: "https://lh3.googleusercontent.com/a/ada", provider: "google" }), null);
});

test("an upload replaces the avatar and deletes the old picture; only small images are taken", async (t) => {
  const { objects, writes } = aws(t, { stored: ["id-ada/old.jpg", "id-bo/other.jpg"] });
  const upload = (image: string) => uploadAvatar(ada, JSON.stringify({ image }));
  const done = await upload(Buffer.from(PNG).toString("base64"));
  assert.equal(done.statusCode, 200);
  assert.match(String((JSON.parse(String(done.body)) as { photoUrl: string }).photoUrl), /^https:\/\/spawnpoint-avatars-test\.s3\.eu-central-1\.amazonaws\.com\/id-ada\/[0-9a-f]{64}\.png\?/);
  assert.deepEqual([...objects].sort(), ["id-bo/other.jpg", [...objects].find((key) => key.endsWith(".png"))].sort(), "the old picture goes; another person's stays");
  assert.equal((writes[0]?.ExpressionAttributeValues as Record<string, unknown>)[":source"], "upload");
  assert.equal(JSON.parse(String((await upload(Buffer.from("<svg/>").toString("base64"))).body)).error, "invalid_avatar");
  assert.equal(JSON.parse(String((await upload("not base64!")).body)).error, "invalid_avatar");
  assert.equal(JSON.parse(String((await upload(Buffer.alloc(300 * 1024, 1).toString("base64"))).body)).error, "avatar_too_large");
});

test("removing the avatar deletes the picture and stops a later copy", async (t) => {
  const { objects, writes } = aws(t, { stored: ["id-ada/old.jpg"] });
  const done = await removeAvatar(ada);
  assert.deepEqual(JSON.parse(String(done.body)), { photoUrl: null });
  assert.equal(objects.size, 0);
  assert.match(String(writes[0]?.UpdateExpression), /SET avatar_removed = :now REMOVE avatar_key/);
});

test("a picture link is the same within an hour, so the browser can cache it", async () => {
  const at = (iso: string) => avatarLink("id-ada/x.png", new Date(iso));
  assert.equal(await at("2026-11-24T10:05:00Z"), await at("2026-11-24T10:55:00Z"));
  assert.notEqual(await at("2026-11-24T10:55:00Z"), await at("2026-11-24T11:05:00Z"));
  assert.equal(await avatarLink(null), null);
});
