import assert from "node:assert/strict";
import test from "node:test";

import { identityPhoto } from "../src/access/avatar.ts";

const telegram = { platform: "telegram", platform_user_id: "42", photo_url: "https://t.me/i/userpic/320/ada.jpg" };
const google = { platform: "google", platform_user_id: "g-1", photo_url: "https://lh3.googleusercontent.com/ada" };
const password = { platform: "password", platform_user_id: "sub-1", photo_url: null };

test("a password sign-in shows the photo of the identity's Telegram account", () => {
  assert.equal(identityPhoto([password, google, telegram], { provider: "password", subject: "sub-1" }), telegram.photo_url);
});

test("the signed-in account's own photo comes first, then Telegram's, then any other", () => {
  assert.equal(identityPhoto([telegram, google], { provider: "google", subject: "g-1" }), google.photo_url);
  assert.equal(identityPhoto([google, telegram]), telegram.photo_url);
  assert.equal(identityPhoto([password, google]), google.photo_url);
});

test("no photo is a null, and only an https address counts as one", () => {
  assert.equal(identityPhoto([password]), null);
  assert.equal(identityPhoto([]), null);
  assert.equal(identityPhoto([{ ...telegram, photo_url: "javascript:alert(1)" }]), null);
});
