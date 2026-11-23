import assert from "node:assert/strict";
import test from "node:test";

import { avatarKey, fetchablePhoto, imageType, providerPhoto } from "../src/access/avatar.ts";

const telegram = { platform: "telegram", platform_user_id: "42", photo_url: "https://t.me/i/userpic/320/ada.jpg" };
const google = { platform: "google", platform_user_id: "g-1", photo_url: "https://lh3.googleusercontent.com/a/ada" };
const password = { platform: "password", platform_user_id: "sub-1", photo_url: null };

test("the photo to copy is the signed-in account's, else Telegram's, else any linked provider's", () => {
  assert.deepEqual(providerPhoto([password, google, telegram], { provider: "password", subject: "sub-1" }), { url: telegram.photo_url, provider: "telegram" });
  assert.deepEqual(providerPhoto([telegram, google], { provider: "google", subject: "g-1" }), { url: google.photo_url, provider: "google" });
  assert.deepEqual(providerPhoto([password, google]), { url: google.photo_url, provider: "google" });
  assert.equal(providerPhoto([password]), null);
  assert.equal(providerPhoto([{ ...telegram, photo_url: "https://evil.example/ada.jpg" }]), null, "only a provider's picture host");
});

test("only https on a provider's picture host may be fetched", () => {
  for (const url of ["https://t.me/i/userpic/320/a.jpg", "https://cdn4.telesco.pe/file/a.jpg", "https://lh3.googleusercontent.com/a/b"]) {
    assert.equal(fetchablePhoto(url), true, url);
  }
  for (const url of ["http://t.me/i/userpic/320/a.jpg", "https://t.me.evil.example/a.jpg", "https://user@t.me/a.jpg", "https://t.me:8443/a.jpg", "javascript:alert(1)", "not a url"]) {
    assert.equal(fetchablePhoto(url), false, url);
  }
});

test("an image is a JPEG, PNG or WebP by its first bytes, and nothing else", () => {
  assert.equal(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "png");
  assert.equal(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(imageType(new TextEncoder().encode("<svg xmlns=")), null, "an SVG can carry script");
  assert.equal(imageType(new TextEncoder().encode("GIF89a")), null);
});

test("a picture is stored under its identity, named by its content", () => {
  const key = avatarKey("id-1", new Uint8Array([1, 2, 3]), "png");
  assert.match(key, /^id-1\/[0-9a-f]{64}\.png$/);
  assert.equal(avatarKey("id-1", new Uint8Array([1, 2, 3]), "png"), key);
});
