import "./support/browser.ts";

import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/contract.ts";
import { demoApi } from "../src/demo/api.ts";
import * as store from "../src/demo/store.ts";

// The demo plays POST /me/avatar and POST /me/avatar/delete, with the backend's checks.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

test("the demo keeps an accepted picture, shows it in the session and forgets it on removal", async () => {
  assert.equal(store.avatar(), null);
  for (const bytes of [PNG, WEBP, Buffer.from([0xff, 0xd8, 0xff, 0xe0])]) {
    const link = await demoApi.uploadAvatar(bytes.toString("base64"));
    assert.match(link, /^data:image\/(png|webp|jpeg);base64,/);
    assert.equal(store.avatar(), link);
  }
  const restored = await demoApi.restoreSession();
  assert.ok(restored.status === "authenticated" && restored.session.state === "active" && restored.session.profile.photoUrl === store.avatar());
  await demoApi.removeAvatar();
  assert.equal(store.avatar(), null);
});

test("the demo refuses another type, bad base64 and a picture over 256 KB", async () => {
  const refusal = async (image: string, code: string) => assert.rejects(demoApi.uploadAvatar(image), (error: unknown) => error instanceof ApiError && error.code === code && error.status === 400);
  await refusal(Buffer.from("GIF89a....").toString("base64"), "invalid_avatar");
  await refusal("not base64 !!", "invalid_avatar");
  await refusal(Buffer.concat([PNG, Buffer.alloc(256 * 1024)]).toString("base64"), "avatar_too_large");
  assert.equal(store.avatar(), null);
});
