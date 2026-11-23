import assert from "node:assert/strict";
import test from "node:test";

import { AVATAR_MAX_BYTES, AVATAR_SIZE, prepareAvatar, squareCrop, type AvatarEnvironment } from "../src/core/avatar-image.ts";

type Recorder = { drawn: { x: number; y: number; side: number; size: number }[]; encoded: string[] };

// A fake canvas: it records the draw and answers each encode from `outputs`.
function environment(width: number, height: number, outputs: Readonly<Record<string, Blob | null>>, recorder: Recorder): AvatarEnvironment {
  return {
    decode: async () => ({ width, height }),
    surface: (size) => ({
      draw: (_source, x, y, side) => { recorder.drawn.push({ x, y, side, size }); },
      encode: async (type) => { recorder.encoded.push(type); return outputs[type] ?? null; },
    }),
  };
}

const blobOf = (type: string, bytes: number) => new Blob([new Uint8Array(bytes).fill(65)], { type });
const fresh = (): Recorder => ({ drawn: [], encoded: [] });

test("the crop is the largest centred square", () => {
  assert.deepEqual(squareCrop(1000, 600), { x: 200, y: 0, side: 600 });
  assert.deepEqual(squareCrop(600, 1000), { x: 0, y: 200, side: 600 });
  assert.deepEqual(squareCrop(300, 300), { x: 0, y: 0, side: 300 });
  assert.deepEqual(squareCrop(301, 300), { x: 0, y: 0, side: 300 });
});

test("a picture is drawn as a centred square onto a 256 by 256 surface and sent as WebP", async () => {
  const recorder = fresh();
  const prepared = await prepareAvatar(new Blob(["x"]), environment(1000, 600, { "image/webp": blobOf("image/webp", 3) }, recorder));
  assert.deepEqual(recorder.drawn, [{ x: 200, y: 0, side: 600, size: AVATAR_SIZE }]);
  assert.equal(AVATAR_SIZE, 256);
  assert.deepEqual(recorder.encoded, ["image/webp"]);
  assert.equal(prepared.type, "image/webp");
  assert.equal(prepared.base64, "QUFB");
  assert.equal(prepared.bytes, 3);
});

test("a browser that cannot encode WebP falls back to JPEG", async () => {
  for (const webp of [null, blobOf("image/png", 5)]) {
    const recorder = fresh();
    const prepared = await prepareAvatar(new Blob(["x"]), environment(400, 400, { "image/webp": webp, "image/jpeg": blobOf("image/jpeg", 6) }, recorder));
    assert.deepEqual(recorder.encoded, ["image/webp", "image/jpeg"]);
    assert.equal(prepared.type, "image/jpeg");
  }
});

test("a picture over 256 KB is refused, and one at the limit passes", async () => {
  await assert.rejects(prepareAvatar(new Blob(["x"]), environment(400, 400, { "image/webp": blobOf("image/webp", AVATAR_MAX_BYTES + 1) }, fresh())), /too large/);
  const prepared = await prepareAvatar(new Blob(["x"]), environment(400, 400, { "image/webp": blobOf("image/webp", AVATAR_MAX_BYTES) }, fresh()));
  assert.equal(prepared.bytes, AVATAR_MAX_BYTES);
});

test("a file the browser cannot decode, or no encoder at all, is refused with a sentence", async () => {
  const broken: AvatarEnvironment = { decode: async () => { throw new Error("nope"); }, surface: () => { throw new Error("unused"); } };
  await assert.rejects(prepareAvatar(new Blob(["x"]), broken), /JPEG, PNG or WebP/);
  await assert.rejects(prepareAvatar(new Blob(["x"]), environment(0, 0, {}, fresh())), /JPEG, PNG or WebP/);
  await assert.rejects(prepareAvatar(new Blob(["x"]), environment(10, 10, {}, fresh())), /cannot prepare/);
});
