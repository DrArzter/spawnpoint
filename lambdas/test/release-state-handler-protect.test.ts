import assert from "node:assert/strict";
import test from "node:test";

import { prePromotionArchive } from "../src/handlers/release-state.ts";

const ref = { worldId: "prom", generationId: `gen-${"a".repeat(32)}` };
const object = (stamp: string, digit: string, algorithms = ["SHA256"]) => ({
  key: `worlds/prom/archives/prom-${ref.generationId}-${stamp}-${digit.repeat(64)}.tar.zst`,
  sizeBytes: 1, storedAt: "2026-11-20T00:00:00.000Z", checksumAlgorithms: algorithms,
});

test("the pre-promotion backup is the verified archive the wipe resumes from", () => {
  const older = object("20261119T100000Z", "1");
  const newest = object("20261120T100000Z", "2");
  assert.equal(prePromotionArchive(ref, [newest, older]), newest.key);
});

test("an archive S3 holds no checksum for, or of another wipe, is never kept as the pre-promotion backup", () => {
  const verified = object("20261119T100000Z", "1");
  const unverified = object("20261120T100000Z", "2", []);
  const other = { ...object("20261121T100000Z", "3"), key: `worlds/prom/archives/prom-gen-${"b".repeat(32)}-20261121T100000Z-${"3".repeat(64)}.tar.zst` };
  assert.equal(prePromotionArchive(ref, [verified, unverified, other]), verified.key);
  assert.equal(prePromotionArchive(ref, [unverified]), undefined);
});
